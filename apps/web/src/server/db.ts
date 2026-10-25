import "server-only";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.LOG_LEVEL === "debug" ? ["query", "warn", "error"] : ["warn", "error"],
    // capture / assignment / scan transactions take an item row lock and write status + history rows;
    // the 5 s default is too tight on a busy or cold server (the callers are idempotent, but should not need to retry)
    transactionOptions: { timeout: 20_000, maxWait: 10_000 },
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

export type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];
