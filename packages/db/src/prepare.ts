import type { PrismaClient } from "@prisma/client";

/**
 * SQLite uses one local API writer. Set the connection's safety pragmas before
 * accepting requests; PostgreSQL keeps its existing startup behavior.
 * First-run schema creation and backup/migration orchestration are handled by
 * initializeSqliteDatabase before the API begins listening.
 */
export async function prepareDatabase(db: PrismaClient, databaseUrl = process.env.DATABASE_URL): Promise<void> {
  if (!databaseUrl?.startsWith("file:")) return;
  await db.$queryRawUnsafe("PRAGMA journal_mode=WAL");
  await db.$queryRawUnsafe("PRAGMA busy_timeout=5000");
  await db.$queryRawUnsafe("PRAGMA foreign_keys=ON");
  const state = await db.$queryRawUnsafe<Array<{ foreign_keys: bigint | number }>>("PRAGMA foreign_keys");
  if (Number(state[0]?.foreign_keys) !== 1)
    throw new Error("SQLite foreign-key enforcement could not be enabled.");
}
