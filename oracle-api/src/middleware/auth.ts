import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma";

export interface AuthRequest extends Request {
  user?: { id: string; email: string; name: string };
  permissions?: string[];
  isSuperAdmin?: boolean;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as {
      id: string;
      email: string;
      name: string;
    };
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

type AccessRow = { roleName: string | null; key: string | null; granted: boolean | null; fromOverride: boolean };

// Loads the user's role and effective permissions in ONE query and caches the
// result on the request, so routes stacking several requirePermission /
// requireSuperAdmin checks only hit the database once. (The nested Prisma
// include this replaces issued six sequential queries per check.)
// Returns false when the user no longer exists.
async function loadAccess(req: AuthRequest): Promise<boolean> {
  if (req.isSuperAdmin !== undefined) return true;
  const rows = await prisma.$queryRaw<AccessRow[]>`
    SELECT r."name" AS "roleName", p."key", NULL::boolean AS "granted", false AS "fromOverride"
      FROM "SystemUser" u
      LEFT JOIN "Role" r ON r."id" = u."roleId"
      LEFT JOIN "RolePermission" rp ON rp."roleId" = r."id"
      LEFT JOIN "Permission" p ON p."id" = rp."permissionId"
     WHERE u."id" = ${req.user!.id}
    UNION ALL
    SELECT NULL, p."key", up."granted", true
      FROM "UserPermission" up
      JOIN "Permission" p ON p."id" = up."permissionId"
     WHERE up."userId" = ${req.user!.id}`;
  const roleRows = rows.filter((r) => !r.fromOverride);
  if (roleRows.length === 0) return false;
  req.isSuperAdmin = roleRows[0].roleName?.trim().toLowerCase() === "super_admin";
  if (req.isSuperAdmin) return true;
  const rolePerms = roleRows.map((r) => r.key).filter((k): k is string => Boolean(k));
  const overrides = rows.filter((r) => r.fromOverride && r.key);
  const granted = overrides.filter((r) => r.granted).map((r) => r.key!);
  const revoked = new Set(overrides.filter((r) => !r.granted).map((r) => r.key!));
  req.permissions = [...new Set([...rolePerms, ...granted])].filter((k) => !revoked.has(k));
  return true;
}

/** Load permissions from DB and attach to req. Call after requireAuth. */
export function requirePermission(key: string) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) { res.status(401).json({ error: "Unauthorized" }); return; }
    try {
      if (!(await loadAccess(req))) { res.status(401).json({ error: "User not found" }); return; }
    } catch (error) { next(error); return; }
    if (req.isSuperAdmin) { next(); return; }
    if (!req.permissions!.includes(key)) {
      res.status(403).json({ error: "Forbidden: missing permission " + key });
      return;
    }
    next();
  };
}

export async function requireSuperAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    if (!(await loadAccess(req))) { res.status(401).json({ error: "User not found" }); return; }
  } catch (error) { next(error); return; }
  if (!req.isSuperAdmin) { res.status(403).json({ error: "Only a Super Admin can perform this action." }); return; }
  next();
}
