// "Who has what" for quantity-managed Tools & Stock — mirrors routes/assignments.ts
// (the Asset assignment workflow: request return -> approve/reject -> returned,
// plus a direct-return bypass) adapted for quantity. Assigning debits `quantity`
// units from `locationId` via an "issue" StockMovement; returning credits them
// back via a "return" StockMovement — so All Items' on-hand Count already
// reflects what's checked out, with no separate "assigned" bookkeeping needed.
import { Router, Response } from "express";
import { prisma } from "../lib/prisma";
import { AuthRequest, requireAuth, requirePermission } from "../middleware/auth";
import { logActivity } from "../lib/activity";

const router = Router();
router.use(requireAuth);

const featureKey = "stock.tools.v1";
const enabled = async () => { if (process.env.STOCK_TOOLS_ENABLED !== "true") return false; const f = await prisma.featureRollout.findUnique({ where: { key: featureKey } }).catch(() => null); return Boolean(f?.enabledGlobally && f.status === "enabled"); };
const gate = (res: Response) => res.status(503).json({ error: "Tools and stock is disabled.", code: "STOCK_DISABLED" });

const include = {
  stockItem: { select: { id: true, sku: true, name: true, category: true, unitOfMeasure: true } },
  employee: { select: { id: true, name: true, employeeId: true, department: { select: { id: true, name: true } }, branch: { select: { id: true, name: true } } } },
  location: { select: { id: true, name: true, branchId: true } },
};

async function scopedLocation(req: AuthRequest, locationId: string) {
  const [location, account] = await Promise.all([
    prisma.stockLocation.findUnique({ where: { id: locationId } }),
    prisma.systemUser.findUnique({ where: { id: req.user!.id }, select: { branchId: true, role: { select: { name: true } } } }),
  ]);
  const global = account?.role?.name.toLowerCase() === "super_admin";
  return { location, allowed: Boolean(location && !location.archivedAt && (global || location.branchId === account?.branchId)) };
}

// GET /api/stock/assignments/stats — must be before /:id
router.get("/stats", requirePermission("view_stock"), async (_req: AuthRequest, res: Response) => {
  if (!(await enabled())) return gate(res);
  const [total, active, pendingReturn, returned] = await Promise.all([
    prisma.stockAssignment.count(),
    prisma.stockAssignment.count({ where: { status: "active" } }),
    prisma.stockAssignment.count({ where: { status: "pending_return" } }),
    prisma.stockAssignment.count({ where: { status: "returned" } }),
  ]);
  res.json({ total, active, pendingReturn, returned });
});

// GET /api/stock/assignments/pending-returns — must be before /:id
router.get("/pending-returns", requirePermission("approve_transactions"), async (_req: AuthRequest, res: Response) => {
  if (!(await enabled())) return gate(res);
  const assignments = await prisma.stockAssignment.findMany({ where: { status: "pending_return" }, include, orderBy: { returnRequestedAt: "asc" } });
  res.json(assignments);
});

// GET /api/stock/assignments
router.get("/", requirePermission("view_stock"), async (req: AuthRequest, res: Response) => {
  if (!(await enabled())) return gate(res);
  const account = await prisma.systemUser.findUnique({ where: { id: req.user!.id }, select: { branchId: true, role: { select: { name: true } } } });
  const global = account?.role?.name.toLowerCase() === "super_admin";
  const assignments = await prisma.stockAssignment.findMany({
    where: global ? {} : { location: { branchId: account?.branchId ?? "" } },
    include,
    orderBy: { assignedAt: "desc" },
  });
  res.json(assignments);
});

// POST /api/stock/assignments — assign (issue) stock to an employee
router.post("/", requirePermission("manage_stock"), async (req: AuthRequest, res: Response) => {
  if (!(await enabled())) return gate(res);
  const b = req.body as Record<string, unknown>;
  const key = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"].trim() : "";
  const stockItemId = typeof b.stockItemId === "string" ? b.stockItemId : "";
  const employeeId = typeof b.employeeId === "string" ? b.employeeId : "";
  const locationId = typeof b.locationId === "string" ? b.locationId : "";
  const notes = typeof b.notes === "string" && b.notes.trim() ? b.notes.trim() : null;
  const quantity = Number(b.quantity);
  if (!key || !stockItemId || !employeeId || !locationId || !Number.isFinite(quantity) || quantity <= 0) {
    return res.status(400).json({ error: "stockItemId, employeeId, locationId, a positive quantity, and Idempotency-Key are required.", code: "INVALID_STOCK_ASSIGNMENT" });
  }

  const requestFingerprint = JSON.stringify({ stockItemId, employeeId, locationId, quantity });
  const existingMovement = await prisma.stockMovement.findUnique({ where: { idempotencyKey: key } });
  if (existingMovement) {
    if (existingMovement.requestFingerprint !== requestFingerprint) return res.status(409).json({ error: "Idempotency-Key was already used for different content.", code: "IDEMPOTENCY_KEY_REUSED" });
    const existing = await prisma.stockAssignment.findUnique({ where: { issueMovementId: existingMovement.id }, include });
    return res.status(200).json(existing);
  }

  const [item, employee, scope] = await Promise.all([
    prisma.stockItem.findUnique({ where: { id: stockItemId } }),
    prisma.employee.findUnique({ where: { id: employeeId } }),
    scopedLocation(req, locationId),
  ]);
  if (!item || !item.active || item.archivedAt) return res.status(409).json({ error: "Stock item is missing or archived.", code: "STOCK_ITEM_ARCHIVED" });
  if (!employee) return res.status(404).json({ error: "Employee not found.", code: "EMPLOYEE_NOT_FOUND" });
  if (!scope.allowed) return res.status(403).json({ error: "Location is outside your scope or archived.", code: "STOCK_LOCATION_FORBIDDEN" });

  try {
    const assignment = await prisma.$transaction(async (tx) => {
      const rows = await tx.stockLedgerEntry.findMany({ where: { movement: { stockItemId }, locationId }, select: { quantityDelta: true } });
      const available = rows.reduce((sum, row) => sum + Number(row.quantityDelta), 0);
      if (quantity > available) throw Object.assign(new Error("INSUFFICIENT_STOCK"), { code: "INSUFFICIENT_STOCK", available });

      const movement = await tx.stockMovement.create({
        data: {
          stockItemId, movementType: "issue", quantity, reason: notes || `Issued to ${employee.name}`,
          idempotencyKey: key, requestFingerprint, performedById: req.user!.id, relatedEmployeeId: employeeId,
        },
      });
      await tx.stockLedgerEntry.create({ data: { movementId: movement.id, locationId, quantityDelta: -quantity } });
      return tx.stockAssignment.create({
        data: { stockItemId, employeeId, locationId, quantity, notes, issueMovementId: movement.id },
        include,
      });
    });

    await logActivity({ userId: req.user!.id, action: "stock_assign", entity: "StockAssignment", entityId: assignment.id, branchId: scope.location?.branchId ?? null, metadata: { item: item.name, employee: employee.name, quantity } });
    res.status(201).json(assignment);
  } catch (err) {
    if (err instanceof Error && (err as { code?: string }).code === "INSUFFICIENT_STOCK") {
      return res.status(409).json({ error: `Only ${(err as { available?: number }).available ?? 0} ${item.unitOfMeasure} available at this location.`, code: "INSUFFICIENT_STOCK" });
    }
    throw err;
  }
});

// GET /api/stock/assignments/:id
router.get("/:id", requirePermission("view_stock"), async (req: AuthRequest, res: Response) => {
  if (!(await enabled())) return gate(res);
  const assignment = await prisma.stockAssignment.findUnique({ where: { id: req.params.id }, include });
  if (!assignment) return res.status(404).json({ error: "Assignment not found." });
  res.json(assignment);
});

// PUT /api/stock/assignments/:id/request-return
router.put("/:id/request-return", requirePermission("manage_stock"), async (req: AuthRequest, res: Response) => {
  if (!(await enabled())) return gate(res);
  const notes = typeof req.body?.notes === "string" && req.body.notes.trim() ? req.body.notes.trim() : null;
  const assignment = await prisma.stockAssignment.findUnique({ where: { id: req.params.id }, include });
  if (!assignment) return res.status(404).json({ error: "Assignment not found." });
  if (assignment.status !== "active") return res.status(400).json({ error: "Assignment is not active." });

  const updated = await prisma.stockAssignment.update({
    where: { id: assignment.id },
    data: { status: "pending_return", returnRequestedAt: new Date(), returnRequestedBy: req.user!.id, returnNotes: notes },
    include,
  });

  await logActivity({ userId: req.user!.id, action: "stock_return_requested", entity: "StockAssignment", entityId: assignment.id, branchId: assignment.location.branchId, metadata: { item: assignment.stockItem.name, employee: assignment.employee.name } });
  res.json(updated);
});

// PUT /api/stock/assignments/:id/approve-return
router.put("/:id/approve-return", requirePermission("approve_transactions"), async (req: AuthRequest, res: Response) => {
  if (!(await enabled())) return gate(res);
  const notes = typeof req.body?.notes === "string" && req.body.notes.trim() ? req.body.notes.trim() : null;
  const assignment = await prisma.stockAssignment.findUnique({ where: { id: req.params.id }, include });
  if (!assignment) return res.status(404).json({ error: "Assignment not found." });
  if (assignment.status !== "pending_return") return res.status(400).json({ error: "Assignment is not pending return." });

  const updated = await prisma.$transaction(async (tx) => {
    const movement = await tx.stockMovement.create({
      data: {
        stockItemId: assignment.stockItemId, movementType: "return", quantity: assignment.quantity,
        reason: notes || `Returned by ${assignment.employee.name}`,
        idempotencyKey: `stock-assignment-return-${assignment.id}`,
        requestFingerprint: JSON.stringify({ assignmentId: assignment.id, type: "return" }),
        performedById: req.user!.id, relatedEmployeeId: assignment.employeeId,
      },
    });
    await tx.stockLedgerEntry.create({ data: { movementId: movement.id, locationId: assignment.locationId, quantityDelta: assignment.quantity } });
    return tx.stockAssignment.update({ where: { id: assignment.id }, data: { status: "returned", returnedAt: new Date(), returnMovementId: movement.id }, include });
  });

  await logActivity({ userId: req.user!.id, action: "stock_return_approved", entity: "StockAssignment", entityId: assignment.id, branchId: assignment.location.branchId, metadata: { item: assignment.stockItem.name, employee: assignment.employee.name } });
  res.json(updated);
});

// PUT /api/stock/assignments/:id/reject-return
router.put("/:id/reject-return", requirePermission("approve_transactions"), async (req: AuthRequest, res: Response) => {
  if (!(await enabled())) return gate(res);
  const notes = typeof req.body?.notes === "string" ? req.body.notes.trim() : "";
  const assignment = await prisma.stockAssignment.findUnique({ where: { id: req.params.id }, include });
  if (!assignment) return res.status(404).json({ error: "Assignment not found." });
  if (assignment.status !== "pending_return") return res.status(400).json({ error: "Assignment is not pending return." });

  const updated = await prisma.stockAssignment.update({
    where: { id: assignment.id },
    data: { status: "active", returnRequestedAt: null, returnRequestedBy: null, returnNotes: null },
    include,
  });

  await logActivity({ userId: req.user!.id, action: "stock_return_rejected", entity: "StockAssignment", entityId: assignment.id, branchId: assignment.location.branchId, metadata: { item: assignment.stockItem.name, employee: assignment.employee.name, reason: notes || undefined } });
  res.json(updated);
});

// POST /api/stock/assignments/:id/return — direct return, bypasses request/approve
router.post("/:id/return", requirePermission("approve_transactions"), async (req: AuthRequest, res: Response) => {
  if (!(await enabled())) return gate(res);
  const notes = typeof req.body?.notes === "string" && req.body.notes.trim() ? req.body.notes.trim() : null;
  const assignment = await prisma.stockAssignment.findUnique({ where: { id: req.params.id }, include });
  if (!assignment) return res.status(404).json({ error: "Assignment not found." });
  if (assignment.status === "returned") return res.status(400).json({ error: "Assignment is already returned." });

  const updated = await prisma.$transaction(async (tx) => {
    const movement = await tx.stockMovement.create({
      data: {
        stockItemId: assignment.stockItemId, movementType: "return", quantity: assignment.quantity,
        reason: notes || `${assignment.stockItem.name} returned by ${assignment.employee.name}`,
        idempotencyKey: `stock-assignment-return-${assignment.id}`,
        requestFingerprint: JSON.stringify({ assignmentId: assignment.id, type: "return" }),
        performedById: req.user!.id, relatedEmployeeId: assignment.employeeId,
      },
    });
    await tx.stockLedgerEntry.create({ data: { movementId: movement.id, locationId: assignment.locationId, quantityDelta: assignment.quantity } });
    return tx.stockAssignment.update({ where: { id: assignment.id }, data: { status: "returned", returnedAt: new Date(), returnNotes: notes, returnMovementId: movement.id }, include });
  });

  await logActivity({ userId: req.user!.id, action: "stock_return_recorded", entity: "StockAssignment", entityId: assignment.id, branchId: assignment.location.branchId, metadata: { item: assignment.stockItem.name, employee: assignment.employee.name, notes: notes || undefined } });
  res.json(updated);
});

export default router;
