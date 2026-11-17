import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeSqliteDatabase, PrismaClient, sqliteFileUrl, splitSqlStatements } from "@updatepilot/db";

// Run only with the SQLite-generated Prisma client. This suite never opens the
// user's PostgreSQL database; every database and migration fixture is temporary.
const sqlite = process.env.UPDATE_X_SQLITE_TEST === "1" ? describe : describe.skip;

sqlite("offline SQLite startup and recovery", () => {
  let root: string;
  let migrations: string;
  const clients: PrismaClient[] = [];
  const connect = (file: string) => {
    const client = new PrismaClient({ datasources: { db: { url: sqliteFileUrl(file) } } });
    clients.push(client);
    return client;
  };

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "updatex-lifecycle-"));
    migrations = path.join(root, "migrations");
    await cp(path.resolve(process.cwd(), "../../packages/db/prisma-sqlite/migrations"), migrations,
      { recursive: true });
  });

  afterAll(async () => {
    for (const client of clients) await client.$disconnect();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("splits quoted SQL safely", () => {
    expect(splitSqlStatements("CREATE TABLE x (a TEXT); INSERT INTO x VALUES ('one;two');"))
      .toEqual(["CREATE TABLE x (a TEXT)", "INSERT INTO x VALUES ('one;two')"]);
  });

  it("rejects an empty migration list without creating a database", async () => {
    const directory = path.join(root, "empty-migrations");
    const file = path.join(root, "empty", "updatex.db");
    await mkdir(directory);
    await expect(initializeSqliteDatabase(connect(file),
      { databasePath: file, migrationsDirectory: directory }))
      .rejects.toMatchObject({ code: "SQLITE_SCHEMA_INCOMPATIBLE" });
    expect(await readdir(path.dirname(file))).not.toContain("updatex.db");
  });

  it("initializes a missing database, then repeats without losing data", async () => {
    const file = path.join(root, "first", "updatex.db");
    const first = connect(file);
    const initial = await initializeSqliteDatabase(first, { databasePath: file, migrationsDirectory: migrations });
    expect(initial.created).toBe(true);
    expect(initial.backup).toBeNull();
    await first.user.create({ data: { id: "owner", username: "Owner", passwordHash: "test-only" } });
    await first.$disconnect();
    await initial.release();

    const repeat = connect(file);
    const next = await initializeSqliteDatabase(repeat, { databasePath: file, migrationsDirectory: migrations });
    expect(next.created).toBe(false);
    expect(next.backup).toBeNull();
    expect(await repeat.user.count({ where: { id: "owner" } })).toBe(1);
    await repeat.$disconnect();
    await next.release();
  });

  it("applies an ordered upgrade after a consistent backup", async () => {
    const file = path.join(root, "upgrade", "updatex.db");
    const first = connect(file);
    const original = await initializeSqliteDatabase(first, { databasePath: file, migrationsDirectory: migrations });
    await first.user.create({ data: { id: "preserved", username: "Preserved", passwordHash: "test-only" } });
    await first.$disconnect();
    await original.release();

    const upgradeMigrations = path.join(root, "upgrade-migrations");
    await cp(migrations, upgradeMigrations, { recursive: true });
    const second = path.join(upgradeMigrations, "20261029_add_test_marker");
    await mkdir(second);
    await writeFile(path.join(second, "migration.sql"),
      "CREATE TABLE PhaseTwoTestMarker (id TEXT NOT NULL PRIMARY KEY);");
    const client = connect(file);
    const upgraded = await initializeSqliteDatabase(client,
      { databasePath: file, migrationsDirectory: upgradeMigrations });
    expect(upgraded.backup).toBeTruthy();
    expect(await client.user.count({ where: { id: "preserved" } })).toBe(1);
    const tables = await client.$queryRawUnsafe<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE name = 'PhaseTwoTestMarker'");
    expect(tables).toHaveLength(1);
    const backups = (await readdir(path.dirname(file))).filter(name => name.includes(".backup-"));
    expect(backups).toHaveLength(1);
    await client.$disconnect();
    await upgraded.release();
  });

  it("restores the last working database when a later migration fails", async () => {
    const file = path.join(root, "rollback", "updatex.db");
    const first = connect(file);
    const original = await initializeSqliteDatabase(first, { databasePath: file, migrationsDirectory: migrations });
    await first.user.create({ data: { id: "retained", username: "Retained", passwordHash: "test-only" } });
    await first.$disconnect();
    await original.release();

    const badMigrations = path.join(root, "bad-migrations");
    await cp(migrations, badMigrations, { recursive: true });
    const second = path.join(badMigrations, "20261029_valid_change");
    const third = path.join(badMigrations, "20261030_invalid_change");
    await mkdir(second);
    await mkdir(third);
    await writeFile(path.join(second, "migration.sql"), "CREATE TABLE TemporaryUpgrade (id TEXT PRIMARY KEY);");
    await writeFile(path.join(third, "migration.sql"), "CREATE TABLE BrokenUpgrade (id TEXT); INVALID SQL;");
    await expect(initializeSqliteDatabase(connect(file),
      { databasePath: file, migrationsDirectory: badMigrations }))
      .rejects.toMatchObject({ code: "SQLITE_MIGRATION_FAILED" });
    const recovered = connect(file);
    const state = await initializeSqliteDatabase(recovered,
      { databasePath: file, migrationsDirectory: migrations });
    expect(await recovered.user.count({ where: { id: "retained" } })).toBe(1);
    const tables = await recovered.$queryRawUnsafe<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE name = 'TemporaryUpgrade'");
    expect(tables).toHaveLength(0);
    await recovered.$disconnect();
    await state.release();
  });

  it("reports corruption without resetting the file", async () => {
    const file = path.join(root, "corrupt", "updatex.db");
    await mkdir(path.dirname(file), { recursive: true });
    const bytes = "not-a-sqlite-database";
    await writeFile(file, bytes);
    await expect(initializeSqliteDatabase(connect(file),
      { databasePath: file, migrationsDirectory: migrations }))
      .rejects.toMatchObject({ code: "SQLITE_DATABASE_CORRUPT" });
    expect(await readFile(file, "utf8")).toBe(bytes);
  });

  it("rejects a changed migration checksum without modifying saved data", async () => {
    const file = path.join(root, "incompatible", "updatex.db");
    const first = connect(file);
    const state = await initializeSqliteDatabase(first, { databasePath: file, migrationsDirectory: migrations });
    await first.user.create({ data: { id: "saved", username: "Saved", passwordHash: "test-only" } });
    await first.$disconnect();
    await state.release();
    const changed = path.join(root, "changed-migrations");
    await cp(migrations, changed, { recursive: true });
    const initialFile = path.join(changed, "20261028_sqlite_initial", "migration.sql");
    await writeFile(initialFile, (await readFile(initialFile, "utf8")) + "\n-- changed migration text\n");
    await expect(initializeSqliteDatabase(connect(file),
      { databasePath: file, migrationsDirectory: changed }))
      .rejects.toMatchObject({ code: "SQLITE_SCHEMA_INCOMPATIBLE" });
    const readable = connect(file);
    expect(await readable.user.count({ where: { id: "saved" } })).toBe(1);
    await readable.$disconnect();
  });

  it("allows one startup owner and rejects a concurrent migration process", async () => {
    const file = path.join(root, "concurrent", "updatex.db");
    const first = connect(file);
    const owner = await initializeSqliteDatabase(first, { databasePath: file, migrationsDirectory: migrations });
    await expect(initializeSqliteDatabase(connect(file),
      { databasePath: file, migrationsDirectory: migrations }))
      .rejects.toMatchObject({ code: "SQLITE_DATABASE_LOCKED" });
    await first.$disconnect();
    await owner.release();
    const retry = connect(file);
    const opened = await initializeSqliteDatabase(retry, { databasePath: file, migrationsDirectory: migrations });
    await retry.$disconnect();
    await opened.release();
  });
});
