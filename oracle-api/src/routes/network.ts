import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";
import { requireAuth, requirePermission, requireSuperAdmin, AuthRequest } from "../middleware/auth";
import { encryptDeviceCredentials, decryptDeviceCredentials, deviceCredentialKeyConfigured, type DeviceCredentialPayload } from "../lib/deviceCredentialCrypto";

// Encrypted network device credentials (switch/AP/router logins, SNMP
// communities, VPN keys, Wi-Fi passwords, API keys, recovery codes). The
// network map itself — ISPs, firewalls, switches, and which port each
// computer is plugged into — lives in network-map.ts.
const router = Router();
const branchUser = async (req: AuthRequest) => prisma.systemUser.findUnique({ where: { id: req.user!.id }, select: { branchId: true, role: { select: { name: true } } } });
const superUser = (u: { role: { name: string } | null } | null) => u?.role?.name.toLowerCase() === "super_admin";

router.get("/device-credentials", requireAuth, requirePermission("view_inventory"), requirePermission("view_sensitive_network_fields"), async (req: AuthRequest, res) => {
  const user = await prisma.systemUser.findUnique({ where: { id: req.user!.id }, select: { branchId: true, role: { select: { name: true } } } }); const superAdmin = user?.role?.name?.toLowerCase() === "super_admin";
  if (!superAdmin && !user?.branchId) { res.json({ items: [] }); return; }
  const where = superAdmin ? {} : { asset: { branchId: user!.branchId! } };
  const items = await prisma.networkDeviceCredential.findMany({
    where, orderBy: { updatedAt: "desc" },
    select: { id: true, assetId: true, hasUsername: true, hasPassword: true, hasSnmpCommunity: true, hasVpnKey: true, hasWifiPassword: true, hasApiKey: true, hasRecoveryCode: true, updatedAt: true, asset: { select: { name: true, assetTag: true } } },
  });
  res.json({ items });
});

// Decrypting actual credential values is restricted to super_admin, on top of
// the view_sensitive_network_fields gate above, AND requires the requester to
// re-enter their OWN account password (step-up auth) — this is the one place
// raw device secrets leave encrypted storage, so every attempt is logged,
// successful or not.
router.post("/device-credentials/:assetId/reveal", requireAuth, requireSuperAdmin, async (req: AuthRequest, res) => {
  const currentPassword = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
  if (!currentPassword) { res.status(400).json({ error: "Re-enter your account password to reveal credentials.", code: "PASSWORD_REQUIRED" }); return; }
  const requester = await prisma.systemUser.findUnique({ where: { id: req.user!.id }, select: { password: true } });
  const passwordOk = Boolean(requester) && (await bcrypt.compare(currentPassword, requester!.password));
  if (!passwordOk) {
    await prisma.activityLog.create({ data: { userId: req.user!.id, action: "network_device_credential_reveal_denied", entity: "NetworkDeviceCredential", entityId: req.params.assetId, metadata: { assetId: req.params.assetId, reason: "invalid_password" } } });
    res.status(403).json({ error: "Incorrect password.", code: "INVALID_PASSWORD" });
    return;
  }
  const record = await prisma.networkDeviceCredential.findUnique({ where: { assetId: req.params.assetId } });
  if (!record) { res.status(404).json({ error: "No credentials recorded for this asset." }); return; }
  try {
    const payload = decryptDeviceCredentials(record.ciphertext, record.iv, record.tag);
    await prisma.activityLog.create({ data: { userId: req.user!.id, action: "network_device_credential_revealed", entity: "NetworkDeviceCredential", entityId: record.id, metadata: { assetId: record.assetId } } });
    res.json(payload);
  } catch {
    res.status(503).json({ error: "Device credential encryption is not configured for this environment.", code: "CREDENTIAL_KEY_MISSING" });
  }
});

const CREDENTIAL_FIELDS = ["username", "password", "snmpCommunity", "vpnKey", "wifiPassword", "apiKey", "recoveryCode"] as const;

router.post("/device-credentials", requireAuth, requirePermission("manage_infrastructure_assets"), async (req: AuthRequest, res) => {
  const b = req.body as Record<string, unknown>;
  const assetId = typeof b.assetId === "string" ? b.assetId : "";
  const unknownFields = Object.keys(b).filter((k) => k !== "assetId" && !(CREDENTIAL_FIELDS as readonly string[]).includes(k));
  if (unknownFields.length) { res.status(400).json({ error: "Unknown credential fields.", fieldErrors: unknownFields }); return; }
  if (!deviceCredentialKeyConfigured()) { res.status(503).json({ error: "Device credential encryption is not configured for this environment.", code: "CREDENTIAL_KEY_MISSING" }); return; }
  const asset = await prisma.asset.findUnique({ where: { id: assetId }, select: { branchId: true } });
  const user = await branchUser(req);
  if (!asset) { res.status(404).json({ error: "Asset not found." }); return; }
  if (!superUser(user) && user?.branchId !== asset.branchId) { res.status(403).json({ error: "Asset is outside your scope." }); return; }

  const payload: DeviceCredentialPayload = {};
  const flags: Record<string, boolean> = {};
  for (const field of CREDENTIAL_FIELDS) {
    const value = b[field];
    if (typeof value === "string" && value.trim()) { payload[field] = value.trim(); flags[`has${field[0].toUpperCase()}${field.slice(1)}`] = true; }
    else { flags[`has${field[0].toUpperCase()}${field.slice(1)}`] = false; }
  }
  const { ciphertext, iv, tag } = encryptDeviceCredentials(payload);

  const result = await prisma.$transaction(async (tx) => {
    const saved = await tx.networkDeviceCredential.upsert({
      where: { assetId },
      create: { assetId, ciphertext, iv, tag, updatedById: req.user!.id, ...flags },
      update: { ciphertext, iv, tag, updatedById: req.user!.id, ...flags },
    });
    await tx.activityLog.create({ data: { userId: req.user!.id, action: "network_device_credential_saved", entity: "NetworkDeviceCredential", entityId: saved.id, metadata: { assetId, fieldsSet: Object.keys(payload) } } });
    return saved;
  });
  res.json({ id: result.id, assetId: result.assetId, hasUsername: result.hasUsername, hasPassword: result.hasPassword, hasSnmpCommunity: result.hasSnmpCommunity, hasVpnKey: result.hasVpnKey, hasWifiPassword: result.hasWifiPassword, hasApiKey: result.hasApiKey, hasRecoveryCode: result.hasRecoveryCode, updatedAt: result.updatedAt });
});

export default router;
