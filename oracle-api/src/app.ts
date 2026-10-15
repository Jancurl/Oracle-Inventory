import "dotenv/config";
import express from "express";
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { prisma } from "./lib/prisma";
import authRoutes from "./routes/auth";
import assetsRoutes from "./routes/assets";
import lookupRoutes from "./routes/lookup";
import employeesRoutes from "./routes/employees";
import branchesRoutes from "./routes/branches";
import assignmentsRoutes from "./routes/assignments";
import reportsRoutes from "./routes/reports";
import turnoverRoutes from "./routes/turnover";
import usersRoutes from "./routes/users";
import rolesRoutes from "./routes/roles";
import activityRoutes from "./routes/activity";
import categoriesRoutes from "./routes/categories";
import departmentsRoutes from "./routes/departments";
import importRoutes from "./routes/import";
import maintenanceRoutes from "./routes/maintenance";
import scanRoutes from "./routes/scan";
import hardwareAuditRoutes from "./routes/hardware-audit";
import operationsRoutes from "./routes/operations";
import computerIntakeRoutes from "./routes/computer-intake";
import belarcImportRoutes from "./routes/belarc-import";
import stockRoutes from "./routes/stock";
import cctvRoutes from "./routes/cctv";
import secretReferenceRoutes from "./routes/secret-reference";
import networkRoutes from "./routes/network";
import networkMutationRoutes from "./routes/network-mutations";
import networkDeviceRoutes from "./routes/network-devices";
import phoneRoutes from "./routes/phones";
import infrastructureRoutes from "./routes/infrastructure";

const app = express();
const configuredOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const productionFrontendOrigins = [
  "https://oracle-inventory-delta.vercel.app",
];
const allowedOrigins = new Set([
  ...configuredOrigins,
  ...(process.env.NODE_ENV === "production" ? productionFrontendOrigins : []),
]);

if (process.env.NODE_ENV === "production" && allowedOrigins.size === 0) {
  throw new Error("CORS_ALLOWED_ORIGINS must contain at least one trusted origin in production.");
}

if (process.env.NODE_ENV === "production") {
  for (const key of ["DATABASE_URL", "JWT_SECRET"]) {
    if (!process.env[key]) throw new Error(`${key} must be configured in production.`);
  }
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin)) return res.status(403).json({ error: "Origin is not allowed." });
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,Idempotency-Key");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());
app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/ready", async (_req, res) => {
  try { await prisma.$queryRaw`SELECT 1`; res.json({ status: "ready" }); }
  catch (error) {
  const databaseError = error as { name?: unknown; code?: unknown; message?: unknown };
  const rawMessage =
    typeof databaseError.message === "string"
      ? databaseError.message
      : "No error message";
  const safeMessage = rawMessage.replace(
    /postgres(?:ql)?:\/\/\S+/gi,
    "[REDACTED_DATABASE_URL]"
  );

  console.error("Database readiness check failed", {
    name: databaseError.name,
    code: databaseError.code,
    message: safeMessage
  });

  res.status(503).json({ status: "not_ready" });
}
});

const apiRouter = Router();
apiRouter.use("/auth", authRoutes);
apiRouter.use("/assets", assetsRoutes);
apiRouter.use("/lookup", lookupRoutes);
apiRouter.use("/employees", employeesRoutes);
apiRouter.use("/branches", branchesRoutes);
apiRouter.use("/assignments", assignmentsRoutes);
apiRouter.use("/reports", reportsRoutes);
apiRouter.use("/turnover", turnoverRoutes);
apiRouter.use("/users", usersRoutes);
apiRouter.use("/roles", rolesRoutes);
apiRouter.use("/activity", activityRoutes);
apiRouter.use("/categories", categoriesRoutes);
apiRouter.use("/departments", departmentsRoutes);
apiRouter.use("/import", importRoutes);
apiRouter.use("/maintenance", maintenanceRoutes);
apiRouter.use("/scan", scanRoutes);
apiRouter.use("/hardware-audit", hardwareAuditRoutes);
apiRouter.use("/operations", operationsRoutes);
apiRouter.use("/computer-intake", computerIntakeRoutes);
apiRouter.use("/belarc-import", belarcImportRoutes);
apiRouter.use("/stock", stockRoutes);
apiRouter.use("/cctv", cctvRoutes);
apiRouter.use("/secret-references", secretReferenceRoutes);
apiRouter.use("/network", networkMutationRoutes);
apiRouter.use("/network", networkRoutes);
apiRouter.use("/network", networkDeviceRoutes);
apiRouter.use("/phones", phoneRoutes);
apiRouter.use("/", infrastructureRoutes);

// Express 4 does not catch rejected promises from async handlers, so a thrown
// Prisma error left the request hanging until the platform timed it out.
// Wrap every handler under the API router so rejections reach the error
// handler below and the client gets a real response.
type RouteHandler = (req: Request, res: Response, next: NextFunction) => unknown;
type RouterLayer = { handle: RouteHandler & { stack?: RouterLayer[] }; route?: { stack: RouterLayer[] } };
const wrappedLayers = new WeakSet<RouterLayer>();

function forwardAsyncErrors(stack: RouterLayer[]) {
  for (const layer of stack) {
    if (wrappedLayers.has(layer)) continue;
    wrappedLayers.add(layer);
    if (layer.route) { forwardAsyncErrors(layer.route.stack); continue; }
    if (layer.handle.stack) { forwardAsyncErrors(layer.handle.stack); continue; }
    const original = layer.handle;
    if (original.length > 3) continue;
    layer.handle = function (this: unknown, req, res, next) {
      try {
        const result = original.call(this, req, res, next);
        if (result && typeof (result as Promise<unknown>).catch === "function") (result as Promise<unknown>).catch(next);
      } catch (error) { next(error); }
    };
  }
}
forwardAsyncErrors((apiRouter as unknown as { stack: RouterLayer[] }).stack);

app.use("/api", apiRouter);

// Vercel's file-system router intercepts nested paths beginning with `/api/`
// before the Express catch-all receives them. The frontend keeps its public
// `/api/*` contract and proxies it to this internal, Vercel-safe gateway.
app.use("/gateway", apiRouter);

const databaseUnavailableCodes = new Set(["P1000", "P1001", "P1002", "P1003", "P1008", "P1010", "P1017", "P2010", "P2024"]);

app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) { next(error); return; }
  const known = error as { name?: unknown; code?: unknown; message?: unknown; status?: unknown };
  const code = typeof known.code === "string" ? known.code : "";
  const rawMessage = typeof known.message === "string" ? known.message : "No error message";
  console.error("Unhandled API error", {
    name: known.name,
    code,
    message: rawMessage.replace(/postgres(?:ql)?:\/\/\S+/gi, "[REDACTED_DATABASE_URL]"),
  });

  // DriverAdapterError is how the pg driver reports connection-level failures, such as the pooler having no free slot.
  if (databaseUnavailableCodes.has(code) || known.name === "PrismaClientInitializationError" || known.name === "DriverAdapterError") {
    res.status(503).json({ error: "The database is not reachable right now. Please try again in a few minutes." });
    return;
  }
  if (code === "P2002") { res.status(409).json({ error: "A record with the same unique value already exists." }); return; }
  if (code === "P2003") { res.status(409).json({ error: "This record is linked to other records and cannot be changed that way." }); return; }
  if (code === "P2025") { res.status(404).json({ error: "Record not found." }); return; }
  if (known.name === "PrismaClientValidationError") { res.status(400).json({ error: "Some of the submitted values are not valid. Check the form and try again." }); return; }
  if (known.name === "MulterError") { res.status(400).json({ error: rawMessage }); return; }
  if (typeof known.status === "number" && known.status >= 400 && known.status < 500) { res.status(known.status).json({ error: "The request could not be read." }); return; }
  res.status(500).json({ error: "Something went wrong on the server. Please try again." });
});

export default app;
