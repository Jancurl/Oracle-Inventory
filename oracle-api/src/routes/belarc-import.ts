import { Router, Response, NextFunction } from "express";
import multer from "multer";
import { Prisma } from "../generated/prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth, requirePermission, AuthRequest } from "../middleware/auth";
import { logActivity } from "../lib/activity";
import { parseBelarc } from "../lib/belarc/parseBelarc";
import { NotABelarcReportError } from "../lib/belarc/types";
import { belarcToInventory, type BelarcComponent, type BelarcFill } from "../lib/belarc/toInventory";
import { nextAssetTag, secret } from "./computer-intake";

// Fills computer records from Belarc Advisor reports. A report is read, turned
// into form values and shown to the user; nothing is written until they save.
// The report itself is never stored — only the values the user saves.
const router = Router();
router.use(requireAuth);

// Vercel caps a request body at 4.5MB, so reports are sent one per request.
const reportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /\.html?$/i.test(file.originalname) || file.mimetype === "text/html"),
});
function readReportFile(req: AuthRequest, res: Response, next: NextFunction) {
  reportUpload.single("file")(req, res, (err: unknown) => {
    if (!err) { next(); return; }
    const tooLarge = (err as { code?: string }).code === "LIMIT_FILE_SIZE";
    res.status(400).json({ error: tooLarge ? "This report is larger than 4MB." : "Could not read the uploaded report." });
  });
}

function decodeReport(buffer: Buffer): string {
  // Some Windows tools save the report as UTF-16
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  return buffer.toString("utf-8");
}

class ImportError extends Error {}

const matchSelect = {
  id: true, name: true, assetTag: true, serialNumber: true, computerName: true, macAddress: true, branchId: true,
  branch: { select: { id: true, name: true } },
  category: { select: { id: true, name: true } },
  deviceProfile: true,
  components: { where: { type: { in: ["ram", "storage"] } }, select: { id: true } },
} satisfies Prisma.AssetSelect;
type MatchedAsset = Prisma.AssetGetPayload<{ select: typeof matchSelect }>;

const ASSET_FIELDS = ["computerName", "serialNumber", "macAddress"] as const;
const PROFILE_FIELDS = ["brand", "model", "processor", "motherboard", "operatingSystem", "osVersion", "osInstallDate"] as const;
type PlanKey = (typeof ASSET_FIELDS)[number] | (typeof PROFILE_FIELDS)[number];
const LABELS: Record<PlanKey, string> = {
  computerName: "Computer name", serialNumber: "Serial number", macAddress: "MAC address",
  brand: "Brand", model: "Model", processor: "Processor", motherboard: "Motherboard",
  operatingSystem: "Operating system", osVersion: "OS version", osInstallDate: "OS install date",
};

interface PlanItem { key: PlanKey; label: string; report: string; current: string | null; action: "fill" | "same" | "differs" }

function sameValue(key: PlanKey, a: string, b: string): boolean {
  if (key === "macAddress") return a.replace(/[^0-9a-f]/gi, "").toLowerCase() === b.replace(/[^0-9a-f]/gi, "").toLowerCase();
  return a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();
}

// What saving this report onto an existing asset would do. Only empty fields
// are filled; a value someone already entered is kept and reported as differing.
function planFor(fill: BelarcFill, asset: MatchedAsset) {
  const fields: PlanItem[] = [];
  for (const key of [...ASSET_FIELDS, ...PROFILE_FIELDS]) {
    const report = fill[key];
    if (!report) continue;
    const raw = (ASSET_FIELDS as readonly string[]).includes(key) ? asset[key as (typeof ASSET_FIELDS)[number]] : asset.deviceProfile?.[key as (typeof PROFILE_FIELDS)[number]];
    const current = raw instanceof Date ? raw.toISOString().slice(0, 10) : typeof raw === "string" && raw.trim() ? raw.trim() : null;
    fields.push({ key, label: LABELS[key], report, current, action: current === null ? "fill" : sameValue(key, current, report) ? "same" : "differs" });
  }
  const current = asset.components.length;
  const report = fill.components.length;
  return { fields, components: { report, current, action: current === 0 && report > 0 ? ("fill" as const) : ("keep" as const) } };
}

async function userScope(req: AuthRequest) {
  const user = await prisma.systemUser.findUnique({ where: { id: req.user!.id }, select: { branchId: true, role: { select: { name: true } } } });
  const role = user?.role?.name?.trim().toLowerCase() ?? "";
  return {
    role,
    superAdmin: role === "super_admin",
    branchId: user?.branchId ?? null,
    assetWhere: role === "super_admin" ? {} : { branchId: user?.branchId ?? "__no_branch__" },
  };
}

function serialWhere(serial: string): Prisma.AssetWhereInput {
  return { OR: [{ serialNumber: { equals: serial, mode: "insensitive" } }, { deviceProfile: { deviceSerial: { equals: serial, mode: "insensitive" } } }] };
}

// The same computer already in the inventory, matched on the strongest
// identifier the report has: serial number, then MAC, then computer name.
async function findMatch(fill: BelarcFill, scope: Prisma.AssetWhereInput) {
  const tries: [string, Prisma.AssetWhereInput][] = [];
  if (fill.serialNumber) tries.push(["serial number", serialWhere(fill.serialNumber)]);
  if (fill.macAddress) tries.push(["MAC address", { macAddress: { equals: fill.macAddress, mode: "insensitive" } }]);
  if (fill.computerName) tries.push(["computer name", { computerName: { equals: fill.computerName, mode: "insensitive" } }]);
  for (const [matchedBy, where] of tries) {
    const asset = await prisma.asset.findFirst({ where: { AND: [scope, where] }, select: matchSelect, orderBy: { createdAt: "desc" } });
    if (asset) return { asset, matchedBy };
  }
  return null;
}

// POST /api/belarc-import/read — multipart field "file". Writes nothing.
router.post("/read", requirePermission("view_inventory"), readReportFile, async (req: AuthRequest, res: Response) => {
  if (!req.file) { res.status(400).json({ error: "Choose a Belarc Advisor report saved as .html." }); return; }
  let fill: BelarcFill;
  try {
    fill = belarcToInventory(parseBelarc(decodeReport(req.file.buffer)));
  } catch (e) {
    if (e instanceof NotABelarcReportError) {
      res.status(400).json({ error: "This file is not a Belarc Advisor report. In Belarc Advisor, save the report page as .html and upload that file." });
      return;
    }
    throw e;
  }
  const scope = await userScope(req);
  const found = await findMatch(fill, scope.assetWhere);
  res.json({
    fileName: req.file.originalname,
    fill,
    match: found && {
      id: found.asset.id,
      name: found.asset.name,
      assetTag: found.asset.assetTag,
      branch: found.asset.branch,
      category: found.asset.category,
      matchedBy: found.matchedBy,
      plan: planFor(fill, found.asset),
    },
  });
});

// ── Saving ──────────────────────────────────────────────────────────────────
// The client sends back the values /read returned (the user may have changed
// the asset name, branch or category), so they are checked again here.

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function cleanText(value: unknown, max = 191): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new ImportError("The report data is not valid. Read the report again.");
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length > max) throw new ImportError("A value from the report is too long to save.");
  return text || null;
}

function cleanFill(raw: unknown): BelarcFill {
  if (!isRecord(raw)) throw new ImportError("The report data is missing. Read the report again.");
  const date = cleanText(raw.osInstallDate);
  const components = raw.components === undefined ? [] : raw.components;
  if (!Array.isArray(components) || components.length > 32) throw new ImportError("The report data is not valid. Read the report again.");
  const fill: BelarcFill = {
    name: cleanText(raw.name),
    computerName: cleanText(raw.computerName),
    serialNumber: cleanText(raw.serialNumber),
    macAddress: cleanText(raw.macAddress, 64),
    deviceType: raw.deviceType === "laptop" ? "laptop" : "computer",
    brand: cleanText(raw.brand),
    model: cleanText(raw.model),
    processor: cleanText(raw.processor),
    motherboard: cleanText(raw.motherboard),
    operatingSystem: cleanText(raw.operatingSystem),
    osVersion: cleanText(raw.osVersion),
    osInstallDate: date && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) ? date : null,
    profileDate: cleanText(raw.profileDate),
    components: components.map((c: unknown): BelarcComponent => {
      if (!isRecord(c) || (c.type !== "ram" && c.type !== "storage")) throw new ImportError("The report data is not valid. Read the report again.");
      const capacity = cleanText(c.capacity, 16);
      return {
        type: c.type,
        slotOrBay: cleanText(c.slotOrBay) ?? undefined,
        brand: cleanText(c.brand) ?? undefined,
        model: cleanText(c.model) ?? undefined,
        serialNumber: cleanText(c.serialNumber) ?? undefined,
        capacity: capacity && /^\d+(\.\d+)?$/.test(capacity) && Number(capacity) > 0 ? capacity : undefined,
        storageKind: cleanText(c.storageKind, 32)?.toLowerCase() ?? undefined,
      };
    }),
  };
  if (secret(fill)) throw new ImportError("Passwords, keys and other credentials cannot be stored in inventory fields.");
  return fill;
}

function componentRows(assetId: string, deviceProfileId: string, fill: BelarcFill, observedAt: Date) {
  return fill.components.map((c) => ({
    assetId, deviceProfileId, type: c.type,
    slotOrBay: c.slotOrBay ?? null, brand: c.brand ?? null, model: c.model ?? null,
    serialNumber: c.serialNumber ?? null, capacity: c.capacity ?? null, storageKind: c.storageKind ?? null,
    source: "belarc", sourceObservedAt: observedAt,
  }));
}

type Scope = Awaited<ReturnType<typeof userScope>> & { userId: string; canEdit: boolean };

async function createComputer(item: Record<string, unknown>, fill: BelarcFill, scope: Scope) {
  const branchId = typeof item.branchId === "string" ? item.branchId : "";
  if (!branchId) throw new ImportError("Choose a branch for this computer.");
  const branch = await prisma.branch.findUnique({ where: { id: branchId }, select: { archivedAt: true } });
  if (!branch || branch.archivedAt) throw new ImportError("The chosen branch no longer exists.");
  if (!scope.superAdmin && scope.branchId !== branchId) throw new ImportError("You can only add computers to your own branch.");

  const categoryId = typeof item.categoryId === "string" && item.categoryId ? item.categoryId : null;
  if (categoryId) {
    const category = await prisma.category.findUnique({ where: { id: categoryId }, select: { name: true } });
    if (!category || !/desktop|laptop|computer/i.test(category.name)) throw new ImportError("Category must be a desktop, laptop or computer category.");
  }

  const name = cleanText(item.name) ?? fill.name ?? fill.computerName;
  if (!name) throw new ImportError("Give this computer an asset name.");

  // Saving the same report twice must not register the computer twice.
  if (fill.serialNumber) {
    const existing = await prisma.asset.findFirst({ where: serialWhere(fill.serialNumber), select: { name: true, assetTag: true, branchId: true } });
    if (existing) {
      const visible = scope.superAdmin || existing.branchId === scope.branchId;
      throw new ImportError(visible
        ? `Serial number ${fill.serialNumber} is already on ${existing.assetTag ?? existing.name}. Choose "Fill blanks" to update that asset instead.`
        : `Serial number ${fill.serialNumber} is already registered in the inventory.`);
    }
  }

  const assetTag = await nextAssetTag();
  const now = new Date();
  const asset = await prisma.$transaction(async (tx) => {
    const created = await tx.asset.create({
      data: {
        name, assetTag, categoryId, branchId,
        computerName: fill.computerName, serialNumber: fill.serialNumber, macAddress: fill.macAddress,
        ownership: "company", condition: "usable", status: "active",
      },
      select: { id: true, name: true, assetTag: true, branchId: true },
    });
    const profile = await tx.deviceProfile.create({
      data: {
        assetId: created.id, deviceType: fill.deviceType, brand: fill.brand, model: fill.model, deviceSerial: fill.serialNumber,
        processor: fill.processor, motherboard: fill.motherboard, operatingSystem: fill.operatingSystem, osVersion: fill.osVersion,
        osInstallDate: fill.osInstallDate ? new Date(fill.osInstallDate) : null, source: "belarc", sourceObservedAt: now,
      },
    });
    if (fill.components.length) await tx.assetComponent.createMany({ data: componentRows(created.id, profile.id, fill, now) });
    return created;
  });

  await logActivity({ userId: scope.userId, action: "create", entity: "Asset", entityId: asset.id, branchId: asset.branchId, metadata: { name: asset.name, source: "belarc-import", fileName: cleanText(item.fileName) } });
  return { action: "created" as const, assetId: asset.id, assetTag: asset.assetTag, name: asset.name };
}

async function fillExisting(item: Record<string, unknown>, fill: BelarcFill, scope: Scope) {
  if (!scope.canEdit) throw new ImportError("You need permission to edit inventory to update existing computers.");
  const assetId = typeof item.assetId === "string" ? item.assetId : "";
  const asset = await prisma.asset.findFirst({ where: { AND: [{ id: assetId }, scope.assetWhere] }, select: matchSelect });
  if (!asset) throw new ImportError("That asset no longer exists or is outside your branch.");

  const plan = planFor(fill, asset);
  const filled = plan.fields.filter((f) => f.action === "fill");
  const addComponents = plan.components.action === "fill";
  const result = { assetId: asset.id, assetTag: asset.assetTag, name: asset.name };
  if (filled.length === 0 && !addComponents && asset.deviceProfile) return { action: "unchanged" as const, ...result, filled: [] };

  const assetData: Prisma.AssetUpdateInput = {};
  const profileData: Prisma.DeviceProfileUncheckedUpdateInput = {};
  for (const f of filled) {
    if ((ASSET_FIELDS as readonly string[]).includes(f.key)) (assetData as Record<string, string>)[f.key] = f.report;
    else (profileData as Record<string, unknown>)[f.key] = f.key === "osInstallDate" ? new Date(f.report) : f.report;
  }
  if (fill.serialNumber && !asset.deviceProfile?.deviceSerial) profileData.deviceSerial = fill.serialNumber;

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    if (Object.keys(assetData).length) await tx.asset.update({ where: { id: asset.id }, data: assetData });
    let profileId = asset.deviceProfile?.id;
    if (!profileId) {
      const created = await tx.deviceProfile.create({ data: { ...(profileData as Prisma.DeviceProfileUncheckedCreateInput), assetId: asset.id, deviceType: fill.deviceType, source: "belarc", sourceObservedAt: now } });
      profileId = created.id;
    } else if (Object.keys(profileData).length) {
      await tx.deviceProfile.update({ where: { id: profileId }, data: profileData });
    }
    if (addComponents) await tx.assetComponent.createMany({ data: componentRows(asset.id, profileId, fill, now) });
  });

  const labels = [...filled.map((f) => f.label), ...(addComponents ? ["RAM and storage"] : [])];
  await logActivity({ userId: scope.userId, action: "update", entity: "Asset", entityId: asset.id, branchId: asset.branchId, metadata: { name: asset.name, source: "belarc-import", filled: labels, fileName: cleanText(item.fileName) } });
  return { action: "updated" as const, ...result, filled: labels };
}

// POST /api/belarc-import/commit — { items: [{ action, fill, assetId?, name?, categoryId?, branchId?, fileName? }] }
// Each item is saved on its own, so one bad report does not stop the rest.
router.post("/commit", requirePermission("create_inventory"), async (req: AuthRequest, res: Response) => {
  const items = Array.isArray(req.body?.items) ? (req.body.items as unknown[]) : null;
  if (!items || items.length === 0 || items.length > 10) { res.status(400).json({ error: "Send between 1 and 10 reports at a time." }); return; }
  const base = await userScope(req);
  if (base.role !== "admin" && base.role !== "super_admin") { res.status(403).json({ error: "Only an Admin or Super Admin can import computers." }); return; }
  const scope: Scope = { ...base, userId: req.user!.id, canEdit: base.superAdmin || !!req.isSuperAdmin || (req.permissions ?? []).includes("edit_inventory") };

  const results = [];
  for (const [index, raw] of items.entries()) {
    try {
      if (!isRecord(raw)) throw new ImportError("The report data is missing. Read the report again.");
      const fill = cleanFill(raw.fill);
      if (raw.action === "create") results.push({ index, ok: true, ...(await createComputer(raw, fill, scope)) });
      else if (raw.action === "update") results.push({ index, ok: true, ...(await fillExisting(raw, fill, scope)) });
      else throw new ImportError("Choose whether to add this computer or fill an existing one.");
    } catch (e) {
      if (e instanceof ImportError) { results.push({ index, ok: false, error: e.message }); continue; }
      const code = (e as { code?: string }).code;
      if (code === "P2002") { results.push({ index, ok: false, error: "That asset tag was just taken. Save again." }); continue; }
      console.error("belarc import item failed", { code, name: e instanceof Error ? e.name : "UnknownError" });
      results.push({ index, ok: false, error: "This computer could not be saved. Try again." });
    }
  }
  res.json({ results });
});

export default router;
