import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

function createPrismaClient() {
  // A serverless instance keeps its pool open while it sits frozen between
  // requests, so each one may hold only a few connections; otherwise a handful
  // of idle instances use up every slot the Supabase pooler allows.
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 5, idleTimeoutMillis: 10_000 });
  return new PrismaClient({ adapter });
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = globalForPrisma.prisma ?? createPrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
