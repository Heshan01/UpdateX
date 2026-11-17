import { PrismaClient } from "@prisma/client";
export { matchesApplicationSearch, normalizedUsername, normalizeSearch } from "./compatibility";
export { prepareDatabase } from "./prepare";
export { initializeSqliteDatabase, sqliteFileUrl, splitSqlStatements, SqliteStartupError } from "./sqliteLifecycle";
export type { SqliteStartupCode, SqliteInitialization } from "./sqliteLifecycle";

/**
 * API code depends on this package, never on a provider-specific generated path.
 * Generate from prisma/schema.prisma for the legacy PostgreSQL build, or from
 * prisma-sqlite/schema.prisma for the new packaged SQLite build. The two
 * generated clients are build profiles and must never be mixed in one runtime.
 */
export type DatabaseClient = PrismaClient;

const globalForPrisma = globalThis as unknown as { updatepilotPrisma?: PrismaClient };

export const db = globalForPrisma.updatepilotPrisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.updatepilotPrisma = db;

export { PrismaClient, Prisma } from "@prisma/client";
