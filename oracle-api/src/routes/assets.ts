import { Router, Response } from "express";
import multer from "multer";
import { Prisma } from "../generated/prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth, requirePermission, AuthRequest } from "../middleware/auth";
import { logActivity } from "../lib/activity";

const router = Router();
router.use(requireAuth);

const ATTACHMENT_MIME_TYPES = new Set([
  "application/pdf",
  "text/csv",
  "application/zip",
  "application/x-zip-compressed",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ATTACHMENT_MIME_TYPES.has(file.mimetype)),
});

const include = {
  category: { select: { id: true, name: true } },
  branch: { select: { id: true, name: true } },
  assignments: {
    where: { status: "active" as const },
    include: { employee: { select: { id: true, name: true, employeeId: true, department: { select: { id: true, name: true } } } } },
  },
  movementLogs: {
    orderBy: { createdAt: "desc" as const },
    include: { employee: { select: { id: true, name: true } } },
  },
  deviceProfile: true,
  components: true,
};
// Date pickers send "YYYY-MM-DD"; Prisma only accepts a Date or a full ISO
// timestamp. Returns undefined for a value that is not a real date.
function parseDateInput(value: unknown): Date | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

// Vendor and internal notes have no column of their own; they are kept in
// the asset's metadata JSON next to whatever an import stored there. Returns
// undefined when the request sends neither, so metadata is left untouched.
function withDetailFields(existing: unknown, body: { vendor?: unknown; internalNotes?: unknown }): Record<string, unknown> | undefined {
  if (body.vendor === undefined && body.internalNotes === undefined) return undefined;
  const metadata: Record<string, unknown> = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {};
  for (const key of ["vendor", "internalNotes"] as const) {
    if (body[key] === undefined) continue;
    const value = typeof body[key] === "string" ? (body[key] as string).trim() : "";
    if (value) metadata[key] = value; else delete metadata[key];
  }
  return metadata;
}

async function scopedAssetWhere(req: AuthRequest) {
  const user = await prisma.systemUser.findUnique({ where: { id: req.user!.id }, select: { branchId: true, role: { select: { name: true } } } });
  return user?.role?.name?.trim().toLowerCase() === "super_admin" ? {} : { branchId: user?.branchId ?? "__no_branch__" };
}

// GET /api/assets/stats — must be before /:id
router.get("/stats", requirePermission("view_inventory"), async (req: AuthRequest, res: Response) => {
  const scope = await scopedAssetWhere(req);
  const [total, assigned, forRepair, forDisposal, lost, stolen, available] = await Promise.all([
    prisma.asset.count({ where: scope }),
    prisma.assetAssignment.count({ where: { status: "active", asset: scope } }),
    prisma.asset.count({ where: { ...scope, condition: "for_repair" } }),
    prisma.asset.count({ where: { ...scope, condition: "for_disposal" } }),
    prisma.asset.count({ where: { ...scope, status: "lost" } }),
    prisma.asset.count({ where: { ...scope, status: "stolen" } }),
    prisma.asset.count({
      where: { ...scope, status: "active", condition: "usable", assignments: { none: { status: "active" } } },
    }),
  ]);
  res.json({ total, assigned, available, forRepair, forDisposal, lost, stolen });
});

// GET /api/assets
// Backward compatible: no page/limit → full array, unchanged for existing callers.
// Pass page and/or limit to opt into { items, total, page, limit }; q/category/available filter server-side.
router.get("/", requirePermission("view_inventory"), async (req: AuthRequest, res: Response) => {
  const { q, page, limit, category, available } = req.query;
  const scope = await scopedAssetWhere(req);

  const where: Record<string, unknown> = { ...scope };
  if (typeof q === "string" && q.trim()) {
    const term = q.trim();
    where.OR = [
      { name: { contains: term, mode: "insensitive" } },
      { serialNumber: { contains: term, mode: "insensitive" } },
    ];
  }
  if (typeof category === "string" && category.trim() && category !== "All") {
    where.category = { name: category };
  }
  if (available === "true") {
    where.condition = "usable";
    where.assignments = { none: { status: "active" } };
  }

  if (page === undefined && limit === undefined) {
    const assets = await prisma.asset.findMany({ where, include, orderBy: { createdAt: "desc" } });
    res.json(assets);
    return;
  }

  const pageNum  = Math.max(1, parseInt(String(page ?? "1"), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(String(limit ?? "20"), 10) || 20));

  const [items, total] = await Promise.all([
    prisma.asset.findMany({
      where, include, orderBy: { createdAt: "desc" },
      skip: (pageNum - 1) * pageSize,
      take: pageSize,
    }),
    prisma.asset.count({ where }),
  ]);

  res.json({ items, total, page: pageNum, limit: pageSize });
});

// GET /api/assets/:id
router.get("/:id", requirePermission("view_inventory"), async (req: AuthRequest, res: Response) => {
  const asset = await prisma.asset.findFirst({ where: { id: req.params.id, ...(await scopedAssetWhere(req)) }, include });
  if (!asset) { res.status(404).json({ error: "Asset not found" }); return; }
  res.json(asset);
});

// POST /api/assets
router.post("/", requirePermission("create_inventory"), async (req: AuthRequest, res: Response) => {
  const { name, serialNumber, categoryId, branchId, condition, ownership, description, warrantyExpiry, purchaseDate, nextMaintenanceDate, imeiNumber, propertyTag } = req.body;
  if (!name) { res.status(400).json({ error: "Asset name is required." }); return; }
  if (!branchId) { res.status(400).json({ error: "Branch is required." }); return; }

  const warrantyDate = parseDateInput(warrantyExpiry);
  const purchasedOn = parseDateInput(purchaseDate);
  const maintenanceDate = parseDateInput(nextMaintenanceDate);
  if (warrantyDate === undefined) { res.status(400).json({ error: "Warranty expiry must be a valid date." }); return; }
  if (purchasedOn === undefined) { res.status(400).json({ error: "Purchase date must be a valid date." }); return; }
  if (maintenanceDate === undefined) { res.status(400).json({ error: "Next maintenance date must be a valid date." }); return; }

  const metadata = withDetailFields(null, req.body);

  const asset = await prisma.asset.create({
    data: {
      name,
      ...(metadata && Object.keys(metadata).length ? { metadata: metadata as Prisma.InputJsonObject } : {}),
      serialNumber: serialNumber || null,
      categoryId: categoryId || null,
      branchId: branchId || null,
      condition: condition ?? "usable",
      ownership: ownership ?? "company",
      description: description || null,
      warrantyExpiry: warrantyDate,
      purchaseDate: purchasedOn,
      nextMaintenanceDate: maintenanceDate,
      imeiNumber: imeiNumber || null,
      propertyTag: propertyTag || null,
    },
    include,
  });

  await logActivity({ userId: req.user!.id, action: "create", entity: "Asset", entityId: asset.id, branchId: asset.branchId, metadata: { name } });
  res.status(201).json(asset);
});

// PUT /api/assets/:id
router.put("/:id", requirePermission("edit_inventory"), async (req: AuthRequest, res: Response) => {
  const { name, serialNumber, categoryId, branchId, condition, ownership, description, warrantyExpiry, purchaseDate, nextMaintenanceDate, imeiNumber, propertyTag, computerName, macAddress } = req.body;
  if (!name) { res.status(400).json({ error: "Asset name is required." }); return; }

  const warrantyDate = parseDateInput(warrantyExpiry);
  const purchasedOn = parseDateInput(purchaseDate);
  const maintenanceDate = parseDateInput(nextMaintenanceDate);
  if (warrantyDate === undefined) { res.status(400).json({ error: "Warranty expiry must be a valid date." }); return; }
  if (purchasedOn === undefined) { res.status(400).json({ error: "Purchase date must be a valid date." }); return; }
  if (maintenanceDate === undefined) { res.status(400).json({ error: "Next maintenance date must be a valid date." }); return; }

  const existing = await prisma.asset.findUnique({ where: { id: req.params.id } });
  if (!existing) { res.status(404).json({ error: "Asset not found" }); return; }

  const metadata = withDetailFields(existing.metadata, req.body);

  const asset = await prisma.asset.update({
    where: { id: req.params.id },
    data: {
      name,
      ...(metadata ? { metadata: Object.keys(metadata).length ? (metadata as Prisma.InputJsonObject) : Prisma.DbNull } : {}),
      serialNumber: serialNumber || null,
      categoryId: categoryId || null,
      branchId: branchId || null,
      condition: condition ?? existing.condition,
      ownership: ownership ?? existing.ownership,
      description: description || null,
      warrantyExpiry: warrantyExpiry !== undefined ? warrantyDate : existing.warrantyExpiry,
      purchaseDate: purchaseDate !== undefined ? purchasedOn : existing.purchaseDate,
      nextMaintenanceDate: nextMaintenanceDate !== undefined ? maintenanceDate : existing.nextMaintenanceDate,
      imeiNumber: imeiNumber !== undefined ? (imeiNumber || null) : existing.imeiNumber,
      propertyTag: propertyTag !== undefined ? (propertyTag || null) : existing.propertyTag,
      computerName: computerName !== undefined ? (String(computerName ?? "").trim() || null) : existing.computerName,
      macAddress: macAddress !== undefined ? (String(macAddress ?? "").trim() || null) : existing.macAddress,
    },
    include,
  });

  await logActivity({ userId: req.user!.id, action: "update", entity: "Asset", entityId: asset.id, branchId: asset.branchId, metadata: { name } });
  res.json(asset);
});

// DELETE /api/assets/:id
router.delete("/:id", requirePermission("delete_inventory"), async (req: AuthRequest, res: Response) => {
  const existing = await prisma.asset.findUnique({ where: { id: req.params.id } });
  if (!existing) { res.status(404).json({ error: "Asset not found" }); return; }

  try {
    await prisma.$transaction([
      prisma.assetAssignment.deleteMany({ where: { assetId: req.params.id } }),
      prisma.movementLog.deleteMany({ where: { assetId: req.params.id } }),
      prisma.asset.delete({ where: { id: req.params.id } }),
    ]);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to delete asset", detail: err?.message });
    return;
  }

  await logActivity({ userId: req.user!.id, action: "delete", entity: "Asset", entityId: req.params.id, branchId: existing.branchId, metadata: { name: existing.name } });
  res.json({ success: true });
});

// ── Components (peripherals, RAM/storage, etc.) ────────────────────────────────
// Generic child rows on any asset — reused for peripherals (Monitor, Keyboard,
// Printer, etc.) attached to any category, not just the Computer/Laptop
// draft flow's own ram/storage rows.
const componentTypes = new Set([
  "ram", "storage", "monitor", "keyboard", "mouse", "speaker", "webcam", "microphone",
  "printer", "ups", "avr", "clicker", "projector", "tv", "signal_booster", "flash_drive",
  "external_hdd", "hdd_ssd_docking_station", "nvme_docking_station",
]);

const hardwareTypes = new Set(["ram", "storage"]);

function componentData(assetId: string, row: Record<string, unknown>) {
  const clean = (value: unknown) => (typeof value === "string" ? value.trim() || null : null);
  return {
    assetId,
    type: row.type as never,
    slotOrBay: clean(row.slotOrBay),
    brand: clean(row.brand),
    model: clean(row.model),
    serialNumber: clean(row.serialNumber),
    capacity: clean(row.capacity),
    storageKind: clean(row.storageKind),
    propertyTag: clean(row.propertyTag),
  };
}

// POST /api/assets/:id/components
router.post("/:id/components", requirePermission("edit_inventory"), async (req: AuthRequest, res: Response) => {
  const asset = await prisma.asset.findUnique({ where: { id: req.params.id } });
  if (!asset) { res.status(404).json({ error: "Asset not found" }); return; }

  const rows = Array.isArray(req.body?.components) ? req.body.components : [];
  if (rows.length === 0 || rows.length > 64) { res.status(400).json({ error: "Provide 1-64 component rows." }); return; }
  for (const row of rows) {
    if (!row || typeof row !== "object" || !componentTypes.has(row.type)) { res.status(400).json({ error: "Each component row needs a valid type." }); return; }
  }

  const created = await prisma.$transaction(
    rows.map((row: Record<string, unknown>) => prisma.assetComponent.create({ data: componentData(asset.id, row) }))
  );

  await logActivity({ userId: req.user!.id, action: "components_added", entity: "Asset", entityId: asset.id, branchId: asset.branchId, metadata: { count: created.length } });
  res.status(201).json({ items: created });
});

// PUT /api/assets/:id/components
// Replaces one group of rows in a single step, which is what the Edit form
// needs: "hardware" is the device's own RAM/storage, "peripherals" is
// everything attached to it. The other group is left untouched.
router.put("/:id/components", requirePermission("edit_inventory"), async (req: AuthRequest, res: Response) => {
  const asset = await prisma.asset.findUnique({ where: { id: req.params.id } });
  if (!asset) { res.status(404).json({ error: "Asset not found" }); return; }

  const kind = req.body?.kind;
  if (kind !== "hardware" && kind !== "peripherals") { res.status(400).json({ error: "kind must be hardware or peripherals." }); return; }
  const rows = Array.isArray(req.body?.components) ? req.body.components : null;
  if (!rows || rows.length > 64) { res.status(400).json({ error: "Provide at most 64 component rows." }); return; }
  const inGroup = (type: unknown) => typeof type === "string" && componentTypes.has(type) && hardwareTypes.has(type) === (kind === "hardware");
  for (const row of rows) {
    if (!row || typeof row !== "object" || !inGroup(row.type)) { res.status(400).json({ error: "Each component row needs a valid type." }); return; }
  }

  const items = await prisma.$transaction(async (tx) => {
    await tx.assetComponent.deleteMany({ where: { assetId: asset.id, type: { in: [...componentTypes].filter(inGroup) as never } } });
    const profile = kind === "hardware" ? await tx.deviceProfile.findUnique({ where: { assetId: asset.id }, select: { id: true } }) : null;
    const created = [];
    for (const row of rows as Record<string, unknown>[]) {
      created.push(await tx.assetComponent.create({ data: { ...componentData(asset.id, row), deviceProfileId: profile?.id ?? null } }));
    }
    return created;
  });

  await logActivity({ userId: req.user!.id, action: "components_replaced", entity: "Asset", entityId: asset.id, branchId: asset.branchId, metadata: { kind, count: items.length } });
  res.json({ items });
});

// PUT /api/assets/:id/device-profile
// Generic motherboard/processor record for any asset (Server hardware needs
// this too, not just Computer/Laptop) — reuses the same DeviceProfile model.
router.put("/:id/device-profile", requirePermission("edit_inventory"), async (req: AuthRequest, res: Response) => {
  const asset = await prisma.asset.findUnique({ where: { id: req.params.id } });
  if (!asset) { res.status(404).json({ error: "Asset not found" }); return; }

  // Only the fields actually sent are written, so a caller that knows just
  // brand and model does not blank out the processor or operating system.
  const body = (req.body ?? {}) as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  for (const key of ["brand", "model", "processor", "motherboard", "operatingSystem", "osVersion"]) {
    if (body[key] !== undefined) data[key] = typeof body[key] === "string" ? (body[key] as string).trim() || null : null;
  }
  if (body.osInstallDate !== undefined) {
    const installedOn = parseDateInput(body.osInstallDate);
    if (installedOn === undefined) { res.status(400).json({ error: "OS install date must be a valid date." }); return; }
    data.osInstallDate = installedOn;
  }
  if (body.deviceType === "computer" || body.deviceType === "laptop") data.deviceType = body.deviceType;

  const profile = await prisma.deviceProfile.upsert({
    where: { assetId: asset.id },
    create: { assetId: asset.id, ...data },
    update: data,
  });

  await logActivity({ userId: req.user!.id, action: "device_profile_saved", entity: "Asset", entityId: asset.id, branchId: asset.branchId, metadata: {} });
  res.json(profile);
});

// ── Lost / Stolen / Recovery ──────────────────────────────────────────────────

// POST /api/assets/:id/report-lost
router.post("/:id/report-lost", requirePermission("edit_inventory"), async (req: AuthRequest, res: Response) => {
  const { notes } = req.body;
  const asset = await prisma.asset.findUnique({ where: { id: req.params.id } });
  if (!asset) { res.status(404).json({ error: "Asset not found" }); return; }
  if (asset.status === "lost") { res.status(400).json({ error: "Asset is already marked as lost" }); return; }

  // Suspend any active assignments
  await prisma.assetAssignment.updateMany({
    where: { assetId: asset.id, status: { in: ["active", "pending_return"] } },
    data: { status: "returned", returnedAt: new Date() },
  });

  const updated = await prisma.asset.update({
    where: { id: asset.id },
    data: { status: "lost", lostAt: new Date(), lostStolenNotes: notes || null },
    include,
  });

  await prisma.movementLog.create({
    data: { assetId: asset.id, type: "lost_report", notes: notes || `${asset.name} reported as lost` },
  });

  await logActivity({ userId: req.user!.id, action: "report_lost", entity: "Asset", entityId: asset.id, branchId: updated.branchId, metadata: { name: asset.name, notes } });
  res.json(updated);
});

// POST /api/assets/:id/report-stolen
router.post("/:id/report-stolen", requirePermission("edit_inventory"), async (req: AuthRequest, res: Response) => {
  const { notes } = req.body;
  const asset = await prisma.asset.findUnique({ where: { id: req.params.id } });
  if (!asset) { res.status(404).json({ error: "Asset not found" }); return; }
  if (asset.status === "stolen") { res.status(400).json({ error: "Asset is already marked as stolen" }); return; }

  await prisma.assetAssignment.updateMany({
    where: { assetId: asset.id, status: { in: ["active", "pending_return"] } },
    data: { status: "returned", returnedAt: new Date() },
  });

  const updated = await prisma.asset.update({
    where: { id: asset.id },
    data: { status: "stolen", lostAt: new Date(), lostStolenNotes: notes || null },
    include,
  });

  await prisma.movementLog.create({
    data: { assetId: asset.id, type: "stolen_report", notes: notes || `${asset.name} reported as stolen` },
  });

  await logActivity({ userId: req.user!.id, action: "report_stolen", entity: "Asset", entityId: asset.id, branchId: updated.branchId, metadata: { name: asset.name, notes } });
  res.json(updated);
});

// POST /api/assets/:id/recover
// Body: { condition?, notes?, inspector?, skip? }
// skip=true → bypass verification, mark recovered with condition=usable + note "Recovery unverified"
router.post("/:id/recover", requirePermission("edit_inventory"), async (req: AuthRequest, res: Response) => {
  const { condition = "usable", notes, inspector, skip = false } = req.body;
  const asset = await prisma.asset.findUnique({ where: { id: req.params.id } });
  if (!asset) { res.status(404).json({ error: "Asset not found" }); return; }
  if (asset.status === "active") { res.status(400).json({ error: "Asset is not lost or stolen" }); return; }

  const recoveryNotes = skip
    ? "Recovery unverified — marked recovered without inspection"
    : [notes, inspector ? `Inspector: ${inspector}` : null].filter(Boolean).join(" | ");

  const updated = await prisma.asset.update({
    where: { id: asset.id },
    data: {
      status: "active",
      condition: skip ? "usable" : (condition as "usable" | "for_repair" | "for_disposal"),
      lostAt: null,
      lostStolenNotes: null,
    },
    include,
  });

  await prisma.movementLog.create({
    data: { assetId: asset.id, type: "recovery", notes: recoveryNotes || `${asset.name} recovered` },
  });

  await logActivity({ userId: req.user!.id, action: "recovered", entity: "Asset", entityId: asset.id, branchId: updated.branchId, metadata: { name: asset.name, skip, condition } });
  res.json(updated);
});

// ── Attachments ─────────────────────────────────────────────────────────────

// POST /api/assets/:id/attachments
router.post("/:id/attachments", requirePermission("edit_inventory"), attachmentUpload.single("file"), async (req: AuthRequest, res: Response) => {
  const asset = await prisma.asset.findFirst({ where: { id: req.params.id, ...(await scopedAssetWhere(req)) } });
  if (!asset) { res.status(404).json({ error: "Asset not found" }); return; }
  if (!req.file) { res.status(400).json({ error: "A file is required, and must be one of: PDF, CSV, ZIP, DOCX, XLSX, JPEG, PNG, WebP (max 5MB)." }); return; }

  const attachment = await prisma.assetAttachment.create({
    data: {
      assetId: asset.id,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      fileSize: req.file.size,
      data: new Uint8Array(req.file.buffer),
      uploadedById: req.user!.id,
    },
    select: { id: true, fileName: true, mimeType: true, fileSize: true, createdAt: true, uploadedById: true },
  });

  await logActivity({ userId: req.user!.id, action: "attachment_upload", entity: "Asset", entityId: asset.id, branchId: asset.branchId, metadata: { fileName: attachment.fileName } });
  res.status(201).json(attachment);
});

// GET /api/assets/:id/attachments
router.get("/:id/attachments", requirePermission("view_inventory"), async (req: AuthRequest, res: Response) => {
  const asset = await prisma.asset.findFirst({ where: { id: req.params.id, ...(await scopedAssetWhere(req)) } });
  if (!asset) { res.status(404).json({ error: "Asset not found" }); return; }

  const attachments = await prisma.assetAttachment.findMany({
    where: { assetId: asset.id },
    select: { id: true, fileName: true, mimeType: true, fileSize: true, createdAt: true, uploadedBy: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(attachments);
});

// GET /api/assets/attachments/:attachmentId/download
router.get("/attachments/:attachmentId/download", requirePermission("view_inventory"), async (req: AuthRequest, res: Response) => {
  const attachment = await prisma.assetAttachment.findUnique({ where: { id: req.params.attachmentId } });
  if (!attachment) { res.status(404).json({ error: "Attachment not found" }); return; }
  const asset = await prisma.asset.findFirst({ where: { id: attachment.assetId, ...(await scopedAssetWhere(req)) }, select: { id: true } });
  if (!asset) { res.status(404).json({ error: "Attachment not found" }); return; }

  res.setHeader("Content-Type", attachment.mimeType);
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(attachment.fileName)}"`);
  res.send(Buffer.from(attachment.data));
});

// DELETE /api/assets/attachments/:attachmentId
router.delete("/attachments/:attachmentId", requirePermission("edit_inventory"), async (req: AuthRequest, res: Response) => {
  const attachment = await prisma.assetAttachment.findUnique({ where: { id: req.params.attachmentId } });
  if (!attachment) { res.status(404).json({ error: "Attachment not found" }); return; }
  const asset = await prisma.asset.findFirst({ where: { id: attachment.assetId, ...(await scopedAssetWhere(req)) }, select: { id: true, name: true, branchId: true } });
  if (!asset) { res.status(404).json({ error: "Attachment not found" }); return; }

  await prisma.assetAttachment.delete({ where: { id: attachment.id } });
  await logActivity({ userId: req.user!.id, action: "attachment_delete", entity: "Asset", entityId: asset.id, branchId: asset.branchId, metadata: { fileName: attachment.fileName } });
  res.json({ success: true });
});

export default router;
