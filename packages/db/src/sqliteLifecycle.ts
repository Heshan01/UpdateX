import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { prepareDatabase } from "./prepare";

export type SqliteStartupCode =
  | "SQLITE_DATABASE_MISSING"
  | "SQLITE_DATABASE_LOCKED"
  | "SQLITE_DATABASE_CORRUPT"
  | "SQLITE_SCHEMA_INCOMPATIBLE"
  | "SQLITE_MIGRATION_FAILED"
  | "SQLITE_BACKUP_FAILED";

export class SqliteStartupError extends Error {
  constructor(public readonly code: SqliteStartupCode) { super(code); }
}

type Migration = { version: string; checksum: string; statements: string[] };
type MigrationRow = { version: string; checksum: string };
type Lock = { release: () => Promise<void> };

export function sqliteFileUrl(file: string): string {
  return `file:${path.resolve(file).replaceAll("\\", "/")}`;
}

function codeOf(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : undefined;
}

function mapDatabaseError(error: unknown): SqliteStartupError {
  if (error instanceof SqliteStartupError) return error;
  const code = codeOf(error);
  const message = error instanceof Error ? error.message : "";
  if (code === "P1003" || code === "ENOENT" || code === "EACCES" || code === "EPERM")
    return new SqliteStartupError("SQLITE_DATABASE_MISSING");
  if (code === "P1008" || code === "P2034" || code === "EBUSY" || /database is locked|SQLITE_BUSY/i.test(message))
    return new SqliteStartupError("SQLITE_DATABASE_LOCKED");
  if (code === "P2021" || code === "P2022")
    return new SqliteStartupError("SQLITE_SCHEMA_INCOMPATIBLE");
  if (/not a database|malformed|SQLITE_CORRUPT/i.test(message))
    return new SqliteStartupError("SQLITE_DATABASE_CORRUPT");
  return new SqliteStartupError("SQLITE_MIGRATION_FAILED");
}

async function exists(file: string): Promise<boolean> {
  try { await stat(file); return true; }
  catch (error) { if (codeOf(error) === "ENOENT") return false; throw error; }
}

function processIsAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return true;
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return codeOf(error) !== "ESRCH"; }
}

async function acquireLock(databasePath: string): Promise<Lock> {
  const file = `${databasePath}.startup.lock`;
  const token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(file, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); await handle.sync(); }
      finally { await handle.close(); }
      return { release: async () => {
        try {
          const value = JSON.parse(await readFile(file, "utf8")) as { token?: string };
          if (value.token === token) await unlink(file);
        } catch { /* Do not mask the original startup/shutdown outcome. */ }
      } };
    } catch (error) {
      if (codeOf(error) !== "EEXIST") throw mapDatabaseError(error);
      let owner: { pid?: number; token?: string };
      try { owner = JSON.parse(await readFile(file, "utf8")) as typeof owner; }
      catch { throw new SqliteStartupError("SQLITE_DATABASE_LOCKED"); }
      if (processIsAlive(owner.pid)) throw new SqliteStartupError("SQLITE_DATABASE_LOCKED");
      // A rename claims the dead owner's lock file. Only one contender can
      // move that exact file; no live lock is removed or silently overwritten.
      try { await rename(file, `${file}.stale-${randomUUID()}`); }
      catch (renameError) {
        if (codeOf(renameError) !== "ENOENT") throw new SqliteStartupError("SQLITE_DATABASE_LOCKED");
      }
    }
  }
  throw new SqliteStartupError("SQLITE_DATABASE_LOCKED");
}

/** Split SQL without treating semicolons inside quoted strings or comments as boundaries. */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];
    if (lineComment) { if (char === "\n") lineComment = false; continue; }
    if (blockComment) { if (char === "*" && next === "/") { blockComment = false; i += 1; } continue; }
    if (quote) {
      if (char === quote) {
        if (next === quote) { i += 1; continue; }
        quote = null;
      }
      continue;
    }
    if (char === "-" && next === "-") { lineComment = true; i += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; i += 1; continue; }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (char === ";") {
      const statement = sql.slice(start, i).trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
  }
  if (quote || blockComment) throw new SqliteStartupError("SQLITE_SCHEMA_INCOMPATIBLE");
  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

async function migrationsIn(directory: string): Promise<Migration[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => {
    throw new SqliteStartupError("SQLITE_MIGRATION_FAILED");
  });
  const versions = entries.filter(entry => entry.isDirectory() && /^\d{8}_[A-Za-z0-9_]+$/.test(entry.name))
    .map(entry => entry.name).sort();
  if (versions.length === 0) throw new SqliteStartupError("SQLITE_SCHEMA_INCOMPATIBLE");
  return Promise.all(versions.map(async version => {
    const sql = await readFile(path.join(directory, version, "migration.sql"), "utf8").catch(() => {
      throw new SqliteStartupError("SQLITE_MIGRATION_FAILED");
    });
    const parsed = splitSqlStatements(sql);
    if (parsed.some(statement => /^PRAGMA\b/i.test(statement) &&
        !/^PRAGMA\s+foreign_keys\s*=\s*ON$/i.test(statement)))
      throw new SqliteStartupError("SQLITE_SCHEMA_INCOMPATIBLE");
    return { version, checksum: createHash("sha256").update(sql).digest("hex"),
      statements: parsed.filter(statement => !/^PRAGMA\s+foreign_keys\s*=\s*ON$/i.test(statement)) };
  }));
}

async function integrity(db: PrismaClient): Promise<void> {
  const rows = await db.$queryRawUnsafe<Array<{ integrity_check: string }>>("PRAGMA integrity_check");
  if (rows.length !== 1 || rows[0]?.integrity_check !== "ok")
    throw new SqliteStartupError("SQLITE_DATABASE_CORRUPT");
}

async function tableNames(db: PrismaClient): Promise<Set<string>> {
  const rows = await db.$queryRawUnsafe<Array<{ name: string }>>(
    "SELECT name FROM sqlite_master WHERE type = 'table'");
  return new Set(rows.map(row => row.name));
}

const REQUIRED_TABLES = ["User", "Session", "Settings", "Device", "ScanJob", "ScanSnapshot",
  "Application", "ApplicationObservation", "UpdateJob", "PairingRequest", "PairingNonce",
  "AgentNonce", "UpdatePreview", "UpdateEvent", "AuditEvent"];

async function verifySchema(db: PrismaClient, migrations: Migration[]): Promise<number> {
  await integrity(db);
  const tables = await tableNames(db);
  if (!tables.has("_updatex_schema_migrations"))
    throw new SqliteStartupError("SQLITE_SCHEMA_INCOMPATIBLE");
  const applied = await db.$queryRawUnsafe<MigrationRow[]>(
    "SELECT version, checksum FROM _updatex_schema_migrations ORDER BY version");
  if (applied.length > migrations.length) throw new SqliteStartupError("SQLITE_SCHEMA_INCOMPATIBLE");
  for (let i = 0; i < applied.length; i += 1) {
    if (applied[i]?.version !== migrations[i]?.version || applied[i]?.checksum !== migrations[i]?.checksum)
      throw new SqliteStartupError("SQLITE_SCHEMA_INCOMPATIBLE");
  }
  if (applied.length === migrations.length && REQUIRED_TABLES.some(table => !tables.has(table)))
    throw new SqliteStartupError("SQLITE_SCHEMA_INCOMPATIBLE");
  if (applied.length === migrations.length) {
    const brokenRelations = await db.$queryRawUnsafe<unknown[]>("PRAGMA foreign_key_check");
    if (brokenRelations.length) throw new SqliteStartupError("SQLITE_DATABASE_CORRUPT");
    try {
      await Promise.all([
        db.user.findFirst(), db.session.findFirst(), db.settings.findFirst(), db.device.findFirst(),
        db.scanJob.findFirst(), db.scanSnapshot.findFirst(), db.application.findFirst(),
        db.applicationObservation.findFirst(), db.updateJob.findFirst(), db.pairingRequest.findFirst(),
        db.pairingNonce.findFirst(), db.agentNonce.findFirst(), db.updatePreview.findFirst(),
        db.updateEvent.findFirst(), db.auditEvent.findFirst(),
      ]);
    } catch { throw new SqliteStartupError("SQLITE_SCHEMA_INCOMPATIBLE"); }
  }
  return applied.length;
}

async function applyMigrations(db: PrismaClient, migrations: Migration[], isNew: boolean): Promise<void> {
  if (isNew) await db.$executeRawUnsafe(
    "CREATE TABLE _updatex_schema_migrations (version TEXT NOT NULL PRIMARY KEY, checksum TEXT NOT NULL, appliedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  const applied = isNew ? 0 : await verifySchema(db, migrations);
  for (const migration of migrations.slice(applied)) {
    await db.$transaction(async tx => {
      for (const statement of migration.statements) await tx.$executeRawUnsafe(statement);
      await tx.$executeRawUnsafe(
        "INSERT INTO _updatex_schema_migrations (version, checksum) VALUES (?, ?)",
        migration.version, migration.checksum);
    }, { isolationLevel: "Serializable", timeout: 60_000 });
  }
  const finalVersion = await verifySchema(db, migrations);
  if (finalVersion !== migrations.length) throw new SqliteStartupError("SQLITE_SCHEMA_INCOMPATIBLE");
}

async function backupDatabase(db: PrismaClient, databasePath: string): Promise<string> {
  const backup = `${databasePath}.backup-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.db`;
  try {
    await db.$executeRawUnsafe(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
    const copy = new PrismaClient({ datasources: { db: { url: sqliteFileUrl(backup) } } });
    try { await prepareDatabase(copy, sqliteFileUrl(backup)); await integrity(copy); }
    finally { await copy.$disconnect(); }
    return backup;
  } catch { throw new SqliteStartupError("SQLITE_BACKUP_FAILED"); }
}

async function restoreBackup(db: PrismaClient, databasePath: string, backup: string): Promise<void> {
  const marker = `${Date.now()}-${randomUUID()}`;
  const replacement = `${databasePath}.restore-${marker}`;
  const failed = `${databasePath}.failed-${marker}`;
  await copyFile(backup, replacement);
  await db.$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)").catch(() => undefined);
  await db.$disconnect();
  await rename(databasePath, failed);
  try {
    for (const suffix of ["-wal", "-shm"]) {
      if (await exists(`${databasePath}${suffix}`))
        await rename(`${databasePath}${suffix}`, `${failed}${suffix}`);
    }
    await rename(replacement, databasePath);
  } catch (error) {
    if (!await exists(databasePath)) await rename(failed, databasePath).catch(() => undefined);
    throw error;
  }
}

export type SqliteInitialization = { release: () => Promise<void>; version: string; created: boolean; backup: string | null };

/** Hold the startup lock until the API shuts down, so a second API cannot upgrade a live database. */
export async function initializeSqliteDatabase(
  db: PrismaClient,
  options: { databasePath: string; migrationsDirectory: string },
): Promise<SqliteInitialization> {
  const databasePath = path.resolve(options.databasePath);
  await mkdir(path.dirname(databasePath), { recursive: true });
  const lock = await acquireLock(databasePath);
  let backup: string | null = null;
  try {
    const migrations = await migrationsIn(options.migrationsDirectory);
    const latestMigration = migrations[migrations.length - 1];
    if (latestMigration === undefined)
      throw new SqliteStartupError("SQLITE_SCHEMA_INCOMPATIBLE");
    const created = !await exists(databasePath);
    if (created) {
      const temporaryPath = `${databasePath}.initializing-${process.pid}-${randomUUID()}.db`;
      const temporary = new PrismaClient({ datasources: { db: { url: sqliteFileUrl(temporaryPath) } } });
      try {
        await prepareDatabase(temporary, sqliteFileUrl(temporaryPath));
        await applyMigrations(temporary, migrations, true);
        await temporary.$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally { await temporary.$disconnect(); }
      await rename(temporaryPath, databasePath);
    } else {
      await prepareDatabase(db, sqliteFileUrl(databasePath));
      const applied = await verifySchema(db, migrations);
      if (applied < migrations.length) {
        backup = await backupDatabase(db, databasePath);
        await applyMigrations(db, migrations, false);
      }
    }
    await prepareDatabase(db, sqliteFileUrl(databasePath));
    await verifySchema(db, migrations);
    return { release: lock.release, version: latestMigration.version, created, backup };
  } catch (error) {
    if (backup) {
      try { await restoreBackup(db, databasePath, backup); }
      catch { /* Keep both the backup and failed database for manual recovery. */ }
    }
    await lock.release();
    throw mapDatabaseError(error);
  }
}
