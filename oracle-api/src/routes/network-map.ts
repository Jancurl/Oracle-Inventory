import { Router, Response } from "express";
import { NetworkNodeType, NetworkConnectionType } from "../generated/prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth, requirePermission, AuthRequest } from "../middleware/auth";
import { logActivity } from "../lib/activity";

// Network map: for every employee laptop/desktop, which ISP → firewall →
// managed switch → switch → port it goes out through (or, on Wi-Fi, just the
// ISP). Nodes form a tree — switch → managed switch → firewall — so a
// computer only stores its switch, port and ISP; the managed switch and
// firewall are read off the tree.
const router = Router();

const NODE_TYPES = ["isp", "firewall", "managed_switch", "switch"] as const satisfies readonly NetworkNodeType[];
const NODE_LABEL: Record<NetworkNodeType, string> = { isp: "ISP", firewall: "firewall", managed_switch: "managed switch", switch: "switch" };
// Which node types each type may uplink to. ISPs and firewalls are roots: the
// ISP is picked per computer because a firewall can carry several lines.
export const ALLOWED_PARENTS: Record<NetworkNodeType, readonly NetworkNodeType[]> = {
  isp: [],
  firewall: [],
  managed_switch: ["firewall"],
  switch: ["managed_switch", "switch", "firewall"],
};
const PLUGGABLE: readonly NetworkNodeType[] = ["switch", "managed_switch"];
const COMPUTER_CATEGORIES = ["Laptop", "Desktop", "Computer"];

type Account = { branchId: string | null; role: { name: string } | null } | null;
const account = (req: AuthRequest) => prisma.systemUser.findUnique({ where: { id: req.user!.id }, select: { branchId: true, role: { select: { name: true } } } });
const isSuper = (a: Account) => a?.role?.name.toLowerCase() === "super_admin";
const inScope = (a: Account, branchId: string | null) => isSuper(a) || Boolean(a?.branchId && a.branchId === branchId);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const optInt = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
const fail = (res: Response, error: unknown) => {
  console.error("[network-map]", error);
  if (!res.headersSent) res.status(500).json({ error: "Network map request failed." });
};

// ── Path resolution ─────────────────────────────────────────────────────────

export type TreeNode = { id: string; type: NetworkNodeType; parentId: string | null };
export type ResolvedPath = { switchId: string | null; managedSwitchId: string | null; firewallId: string | null };

// Walks up from the switch a computer is plugged into and picks out the
// first managed switch and firewall on the way. A computer plugged straight
// into a managed switch has no separate switch.
export function resolvePath(startId: string | null, nodes: Map<string, TreeNode>): ResolvedPath {
  const path: ResolvedPath = { switchId: null, managedSwitchId: null, firewallId: null };
  const seen = new Set<string>();
  for (let node = startId ? nodes.get(startId) : undefined; node && !seen.has(node.id); node = node.parentId ? nodes.get(node.parentId) : undefined) {
    seen.add(node.id);
    if (node.type === "switch" && !path.switchId) path.switchId = node.id;
    if (node.type === "managed_switch" && !path.managedSwitchId) path.managedSwitchId = node.id;
    if (node.type === "firewall" && !path.firewallId) path.firewallId = node.id;
  }
  return path;
}

// True when `candidateParentId` sits at or below `nodeId`, i.e. making it the
// parent would create a cycle.
export function wouldCycle(nodeId: string, candidateParentId: string, nodes: Map<string, TreeNode>): boolean {
  const seen = new Set<string>();
  for (let id: string | null = candidateParentId; id && !seen.has(id); id = nodes.get(id)?.parentId ?? null) {
    if (id === nodeId) return true;
    seen.add(id);
  }
  return false;
}

// ── Read ────────────────────────────────────────────────────────────────────

router.get("/", requireAuth, requirePermission("view_inventory"), async (req: AuthRequest, res) => {
  try {
    const me = await account(req);
    const requested = str(req.query.branchId) || null;
    if (!isSuper(me) && (!me?.branchId || (requested && requested !== me.branchId))) { res.status(403).json({ error: "Branch is outside your scope." }); return; }
    const branchId = isSuper(me) ? requested : me!.branchId;

    const [nodes, computers] = await Promise.all([
      prisma.networkNode.findMany({
        where: branchId ? { branchId } : {},
        include: { branch: { select: { name: true } } },
        orderBy: [{ type: "asc" }, { name: "asc" }],
      }),
      prisma.asset.findMany({
        where: { ...(branchId ? { branchId } : {}), status: "active", category: { name: { in: COMPUTER_CATEGORIES } } },
        select: {
          id: true, name: true, assetTag: true, computerName: true, branchId: true,
          category: { select: { name: true } },
          branch: { select: { name: true } },
          networkConnection: { select: { connectionType: true, switchId: true, switchPort: true, ispId: true, notes: true, updatedAt: true } },
          assignments: {
            where: { status: { in: ["active", "pending_return"] } }, orderBy: { assignedAt: "desc" }, take: 1,
            select: { employee: { select: { id: true, name: true, position: true, department: { select: { name: true } } } } },
          },
        },
        orderBy: { name: "asc" },
      }),
    ]);

    const tree = new Map(nodes.map((n) => [n.id, { id: n.id, type: n.type, parentId: n.parentId }]));
    const count = new Map<string, number>();
    for (const c of computers) {
      const conn = c.networkConnection;
      if (!conn) continue;
      for (const id of [conn.ispId, conn.connectionType === "wired" ? conn.switchId : null]) if (id) count.set(id, (count.get(id) ?? 0) + 1);
    }

    res.json({
      nodes: nodes.map((n) => ({
        id: n.id, branchId: n.branchId, branchName: n.branch.name, type: n.type, name: n.name,
        parentId: n.parentId, parentPort: n.parentPort, portCount: n.portCount, location: n.location, notes: n.notes,
        computers: count.get(n.id) ?? 0,
      })),
      computers: computers.map((c) => {
        const conn = c.networkConnection;
        const employee = c.assignments[0]?.employee ?? null;
        return {
          id: c.id, name: c.name, assetTag: c.assetTag, computerName: c.computerName, category: c.category?.name ?? null,
          branchId: c.branchId, branchName: c.branch?.name ?? null,
          employee: employee ? { id: employee.id, name: employee.name, position: employee.position, department: employee.department?.name ?? null } : null,
          connection: conn ? {
            type: conn.connectionType, switchPort: conn.switchPort, ispId: conn.ispId, notes: conn.notes, updatedAt: conn.updatedAt,
            ...(conn.connectionType === "wired" ? resolvePath(conn.switchId, tree) : { switchId: null, managedSwitchId: null, firewallId: null }),
            pluggedIntoId: conn.connectionType === "wired" ? conn.switchId : null,
          } : null,
        };
      }),
    });
  } catch (error) { fail(res, error); }
});

// ── Nodes: ISPs, firewalls, managed switches, switches ──────────────────────

type NodeData = { type: NetworkNodeType; name: string; branchId: string; parentId: string | null; parentPort: string | null; portCount: number | null; location: string | null; notes: string | null };
type NodeValidation = { data: NodeData; error?: never; field?: never; status?: never } | { data?: never; error: string; field?: string; status?: number };

async function validateNode(me: Account, body: Record<string, unknown>, existing: { id: string; branchId: string } | null): Promise<NodeValidation> {
  const type = str(body.type) as NetworkNodeType;
  const name = str(body.name);
  const branchId = existing?.branchId ?? (str(body.branchId) || me?.branchId || "");
  const parentId = str(body.parentId) || null;
  const portCount = optInt(body.portCount);
  if (!(NODE_TYPES as readonly string[]).includes(type)) return { error: "Pick what kind of device this is.", field: "type" };
  if (!name) return { error: "Name is required.", field: "name" };
  if (!branchId) return { error: "Branch is required.", field: "branchId" };
  if (!inScope(me, branchId)) return { error: "Branch is outside your scope.", status: 403 };
  if (portCount !== null && (!Number.isInteger(portCount) || portCount < 1 || portCount > 512)) return { error: "Port count must be a whole number between 1 and 512.", field: "portCount" };
  if (parentId) {
    if (!ALLOWED_PARENTS[type].length) return { error: `An ${NODE_LABEL[type]} doesn't connect up to another device.`, field: "parentId" };
    const parent = await prisma.networkNode.findUnique({ where: { id: parentId }, select: { id: true, type: true, branchId: true, name: true } });
    if (!parent || parent.branchId !== branchId) return { error: "Upstream device not found in this branch.", field: "parentId" };
    if (!ALLOWED_PARENTS[type].includes(parent.type)) return { error: `A ${NODE_LABEL[type]} can't connect to a ${NODE_LABEL[parent.type]}.`, field: "parentId" };
    if (existing) {
      const all = await prisma.networkNode.findMany({ where: { branchId }, select: { id: true, type: true, parentId: true } });
      if (wouldCycle(existing.id, parentId, new Map(all.map((n) => [n.id, n])))) return { error: `${parent.name} is already downstream of this device.`, field: "parentId" };
    }
  }
  return {
    data: {
      type, name, branchId, parentId: ALLOWED_PARENTS[type].length ? parentId : null,
      parentPort: parentId ? str(body.parentPort) || null : null,
      portCount: type === "isp" ? null : portCount,
      location: str(body.location) || null,
      notes: str(body.notes) || null,
    },
  };
}

router.post("/nodes", requireAuth, requirePermission("manage_infrastructure_assets"), async (req: AuthRequest, res) => {
  try {
    const me = await account(req);
    const v = await validateNode(me, req.body ?? {}, null);
    if (!v.data) { res.status(v.status ?? 400).json({ error: v.error, fieldErrors: v.field ? [v.field] : [] }); return; }
    const duplicate = await prisma.networkNode.findUnique({ where: { branchId_name: { branchId: v.data.branchId, name: v.data.name } } });
    if (duplicate) { res.status(409).json({ error: `"${v.data.name}" already exists in this branch.`, fieldErrors: ["name"] }); return; }
    const node = await prisma.networkNode.create({ data: v.data });
    await logActivity({ userId: req.user!.id, action: "network_node_created", entity: "NetworkNode", entityId: node.id, branchId: node.branchId, metadata: { name: node.name, type: node.type } });
    res.status(201).json(node);
  } catch (error) { fail(res, error); }
});

router.put("/nodes/:id", requireAuth, requirePermission("manage_infrastructure_assets"), async (req: AuthRequest, res) => {
  try {
    const me = await account(req);
    const existing = await prisma.networkNode.findUnique({ where: { id: req.params.id }, include: { _count: { select: { children: true, switchConnections: true, ispConnections: true } } } });
    if (!existing) { res.status(404).json({ error: "Network device not found." }); return; }
    if (!inScope(me, existing.branchId)) { res.status(403).json({ error: "Device is outside your scope." }); return; }
    const v = await validateNode(me, req.body ?? {}, existing);
    if (!v.data) { res.status(v.status ?? 400).json({ error: v.error, fieldErrors: v.field ? [v.field] : [] }); return; }
    if (v.data.type !== existing.type) {
      const inUse = existing._count.children + existing._count.switchConnections + existing._count.ispConnections;
      if (inUse) { res.status(409).json({ error: `${existing.name} is in use by ${inUse} device${inUse === 1 ? "" : "s"}; move them before changing its type.`, fieldErrors: ["type"] }); return; }
    }
    if (v.data.name !== existing.name) {
      const duplicate = await prisma.networkNode.findUnique({ where: { branchId_name: { branchId: existing.branchId, name: v.data.name } } });
      if (duplicate) { res.status(409).json({ error: `"${v.data.name}" already exists in this branch.`, fieldErrors: ["name"] }); return; }
    }
    const node = await prisma.networkNode.update({ where: { id: existing.id }, data: v.data });
    await logActivity({ userId: req.user!.id, action: "network_node_updated", entity: "NetworkNode", entityId: node.id, branchId: node.branchId, metadata: { name: node.name, type: node.type } });
    res.json(node);
  } catch (error) { fail(res, error); }
});

router.delete("/nodes/:id", requireAuth, requirePermission("manage_infrastructure_assets"), async (req: AuthRequest, res) => {
  try {
    const me = await account(req);
    const node = await prisma.networkNode.findUnique({ where: { id: req.params.id }, include: { _count: { select: { children: true, switchConnections: true, ispConnections: true } } } });
    if (!node) { res.status(404).json({ error: "Network device not found." }); return; }
    if (!inScope(me, node.branchId)) { res.status(403).json({ error: "Device is outside your scope." }); return; }
    const computers = node._count.switchConnections + node._count.ispConnections;
    if (computers || node._count.children) {
      const parts = [computers ? `${computers} computer${computers === 1 ? "" : "s"}` : "", node._count.children ? `${node._count.children} device${node._count.children === 1 ? "" : "s"}` : ""].filter(Boolean);
      res.status(409).json({ error: `${parts.join(" and ")} still connect through ${node.name}. Move them first.` });
      return;
    }
    await prisma.networkNode.delete({ where: { id: node.id } });
    await logActivity({ userId: req.user!.id, action: "network_node_deleted", entity: "NetworkNode", entityId: node.id, branchId: node.branchId, metadata: { name: node.name, type: node.type } });
    res.status(204).end();
  } catch (error) { fail(res, error); }
});

// ── Computers ───────────────────────────────────────────────────────────────

// One computer's resolved connection, for the asset detail page.
router.get("/computers/:assetId", requireAuth, requirePermission("view_inventory"), async (req: AuthRequest, res) => {
  try {
    const me = await account(req);
    const computer = await prisma.asset.findUnique({
      where: { id: req.params.assetId },
      select: { id: true, branchId: true, networkConnection: { include: { isp: { select: { id: true, name: true } } } } },
    });
    if (!computer) { res.status(404).json({ error: "Asset not found." }); return; }
    if (!inScope(me, computer.branchId)) { res.status(403).json({ error: "Asset is outside your scope." }); return; }
    const conn = computer.networkConnection;
    if (!conn) { res.json({ connection: null }); return; }
    let path: ResolvedPath = { switchId: null, managedSwitchId: null, firewallId: null };
    let names = new Map<string, string>();
    if (conn.connectionType === "wired" && conn.switchId) {
      const sw = await prisma.networkNode.findUnique({ where: { id: conn.switchId }, select: { branchId: true } });
      const all = sw ? await prisma.networkNode.findMany({ where: { branchId: sw.branchId }, select: { id: true, type: true, parentId: true, name: true } }) : [];
      path = resolvePath(conn.switchId, new Map(all.map((n) => [n.id, n])));
      names = new Map(all.map((n) => [n.id, n.name]));
    }
    const ref = (id: string | null) => (id ? { id, name: names.get(id) ?? "Unknown" } : null);
    res.json({
      connection: {
        type: conn.connectionType, switchPort: conn.switchPort, notes: conn.notes, updatedAt: conn.updatedAt,
        isp: conn.isp, pluggedInto: ref(conn.connectionType === "wired" ? conn.switchId : null),
        switch: ref(path.switchId), managedSwitch: ref(path.managedSwitchId), firewall: ref(path.firewallId),
      },
    });
  } catch (error) { fail(res, error); }
});

// Body: { type: "wired", switchId, switchPort, ispId, notes? }
//    or { type: "wifi", ispId, notes? }
router.put("/computers/:assetId", requireAuth, requirePermission("manage_infrastructure_assets"), async (req: AuthRequest, res) => {
  try {
    const me = await account(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const type = str(b.type) as NetworkConnectionType;
    const ispId = str(b.ispId);
    const switchId = type === "wired" ? str(b.switchId) : "";
    const switchPort = type === "wired" ? str(b.switchPort) : "";
    if (type !== "wired" && type !== "wifi") { res.status(400).json({ error: "Choose wired or Wi-Fi.", fieldErrors: ["type"] }); return; }
    if (type === "wired" && !switchId) { res.status(400).json({ error: "Pick the switch it's plugged into.", fieldErrors: ["switchId"] }); return; }
    if (type === "wired" && !switchPort) { res.status(400).json({ error: "Enter the switch port.", fieldErrors: ["switchPort"] }); return; }
    if (!ispId) { res.status(400).json({ error: "Pick the ISP.", fieldErrors: ["ispId"] }); return; }

    const computer = await prisma.asset.findUnique({ where: { id: req.params.assetId }, select: { id: true, name: true, branchId: true, category: { select: { name: true } } } });
    if (!computer || !COMPUTER_CATEGORIES.includes(computer.category?.name ?? "")) { res.status(404).json({ error: "Laptop or desktop not found." }); return; }
    if (!inScope(me, computer.branchId)) { res.status(403).json({ error: "Computer is outside your scope." }); return; }

    const picked = await prisma.networkNode.findMany({ where: { id: { in: [ispId, switchId].filter(Boolean) } }, select: { id: true, name: true, type: true, branchId: true, portCount: true } });
    const isp = picked.find((n) => n.id === ispId);
    const sw = switchId ? picked.find((n) => n.id === switchId) : null;
    if (!isp || isp.type !== "isp") { res.status(400).json({ error: "ISP not found.", fieldErrors: ["ispId"] }); return; }
    if (type === "wired" && (!sw || !PLUGGABLE.includes(sw.type))) { res.status(400).json({ error: "Switch not found.", fieldErrors: ["switchId"] }); return; }
    for (const node of [isp, sw]) {
      if (!node) continue;
      if (!inScope(me, node.branchId)) { res.status(403).json({ error: `${node.name} is outside your scope.` }); return; }
      if (computer.branchId && node.branchId !== computer.branchId) { res.status(400).json({ error: `${node.name} is in a different branch from ${computer.name}.` }); return; }
    }
    if (sw?.portCount && /^\d+$/.test(switchPort) && (Number(switchPort) < 1 || Number(switchPort) > sw.portCount)) {
      res.status(400).json({ error: `${sw.name} only has ${sw.portCount} ports.`, fieldErrors: ["switchPort"] }); return;
    }

    const data = { connectionType: type, ispId, switchId: sw?.id ?? null, switchPort: switchPort || null, notes: str(b.notes) || null, updatedById: req.user!.id };
    const saved = await prisma.deviceConnection.upsert({ where: { assetId: computer.id }, create: { assetId: computer.id, ...data }, update: data });
    await logActivity({
      userId: req.user!.id, action: "network_connection_saved", entity: "DeviceConnection", entityId: saved.id, branchId: computer.branchId,
      metadata: { computer: computer.name, type, isp: isp.name, switch: sw?.name ?? null, port: switchPort || null },
    });
    res.json(saved);
  } catch (error) { fail(res, error); }
});

router.delete("/computers/:assetId", requireAuth, requirePermission("manage_infrastructure_assets"), async (req: AuthRequest, res) => {
  try {
    const me = await account(req);
    const computer = await prisma.asset.findUnique({ where: { id: req.params.assetId }, select: { id: true, name: true, branchId: true } });
    if (!computer) { res.status(404).json({ error: "Laptop or desktop not found." }); return; }
    if (!inScope(me, computer.branchId)) { res.status(403).json({ error: "Computer is outside your scope." }); return; }
    const { count } = await prisma.deviceConnection.deleteMany({ where: { assetId: computer.id } });
    if (count) await logActivity({ userId: req.user!.id, action: "network_connection_cleared", entity: "DeviceConnection", entityId: computer.id, branchId: computer.branchId, metadata: { computer: computer.name } });
    res.status(204).end();
  } catch (error) { fail(res, error); }
});

export default router;
