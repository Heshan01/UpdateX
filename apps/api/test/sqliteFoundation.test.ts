import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PrismaClient, prepareDatabase } from "@updatepilot/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Opt in only after `pnpm --filter @updatepilot/db generate:sqlite`.
// All writes are to a disposable file in the OS temporary directory.
const sqlite = process.env.UPDATE_X_SQLITE_TEST === "1" ? describe : describe.skip;

sqlite("SQLite foundation: isolated schema and concurrency", () => {
  let directory: string;
  let db: PrismaClient;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "updatex-sqlite-test-"));
    const database = path.join(directory, "foundation.db").replaceAll("\\", "/");
    const databaseUrl = `file:${database}`;
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prepareDatabase(db, databaseUrl);
    const migration = await readFile(path.resolve(process.cwd(),
      "../../packages/db/prisma-sqlite/migrations/20261028_sqlite_initial/migration.sql"), "utf8");
    for (const statement of migration.split(";").map(part => part.trim()).filter(Boolean))
      await db.$executeRawUnsafe(statement);
  });

  afterAll(async () => {
    await db?.$disconnect();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("creates all logical tables, relationships, and case-insensitive username uniqueness", async () => {
    const tables = await db.$queryRawUnsafe<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_prisma_%'");
    const expected = ["User", "Session", "Settings", "Device", "ScanJob", "ScanSnapshot",
      "Application", "ApplicationObservation", "UpdateJob", "PairingRequest", "PairingNonce",
      "AgentNonce", "UpdatePreview", "UpdateEvent", "AuditEvent"];
    expect(expected.every(name => tables.some(table => table.name === name))).toBe(true);
    const foreignKeys = await db.$queryRawUnsafe<Array<{ foreign_keys: bigint | number }>>("PRAGMA foreign_keys");
    expect(Number(foreignKeys[0]?.foreign_keys)).toBe(1);
    await db.user.create({ data: { id: "owner", username: "Owner", passwordHash: "test-only" } });
    await expect(db.user.create({ data: { username: "owner", passwordHash: "test-only" } }))
      .rejects.toMatchObject({ code: "P2002" });
    await db.device.create({ data: { id: "device", ownerId: "owner", name: "Test device",
      executionMode: "update_enabled", publicKeyPem: "test-public-key" } });
    await db.scanJob.create({ data: { id: "scan", deviceId: "device", requestedBy: "owner" } });
    await db.scanSnapshot.create({ data: { id: "snapshot", deviceId: "device", scanJobId: "scan" } });
    await db.application.create({ data: { id: "application", snapshotId: "snapshot", stableKey: "test",
      displayName: "Éditeur", installedVersion: "1", packageId: "Example.Editor" } });
    await db.applicationObservation.create({ data: { applicationId: "application", sourceKey: "registry:key",
      evidenceType: "registry", displayName: "Éditeur" } });
    expect(await db.applicationObservation.count({ where: { applicationId: "application" } })).toBe(1);
    await expect(db.applicationObservation.create({ data: { applicationId: "missing", sourceKey: "invalid",
      evidenceType: "registry", displayName: "Invalid" } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("atomically consumes one preview and rolls back a failed transaction", async () => {
    await db.updatePreview.create({ data: { id: "preview", ownerId: "owner", deviceId: "device",
      applicationId: "application", packageId: "Example.Editor", source: "winget",
      installedVersion: "1", targetVersion: "2", evidenceHash: "hash",
      expiresAt: new Date(Date.now() + 60000) } });
    const attempts = await Promise.allSettled(Array.from({ length: 4 }, () =>
      db.updatePreview.updateMany({ where: { id: "preview", consumedAt: null },
        data: { consumedAt: new Date() } })));
    expect(attempts.filter(result => result.status === "fulfilled" && result.value.count === 1)).toHaveLength(1);
    await expect(db.$transaction(async tx => {
      await tx.agentNonce.create({ data: { deviceId: "device", nonce: "rollback" } });
      throw new Error("rollback requested");
    })).rejects.toThrow("rollback requested");
    expect(await db.agentNonce.count({ where: { deviceId: "device", nonce: "rollback" } })).toBe(0);
  });

  it("allows only one claim of the same queued update and one use of a signed nonce", async () => {
    await db.updateJob.create({ data: { id: "job", deviceId: "device", applicationId: "application",
      requestedBy: "owner", packageId: "Example.Editor", source: "winget", targetVersion: "2",
      previewId: "preview", idempotencyKey: "intent-one" } });
    const claims = await Promise.allSettled(Array.from({ length: 6 }, () =>
      db.updateJob.updateMany({ where: { id: "job", deviceId: "device", status: "queued",
        device: { revokedAt: null, executionMode: "update_enabled" } },
        data: { status: "leased", leaseUntil: new Date(Date.now() + 60000) } })));
    expect(claims.filter(result => result.status === "fulfilled" && result.value.count === 1)).toHaveLength(1);
    expect(await db.updateJob.count({ where: { id: "job", status: "leased" } })).toBe(1);
    await expect(db.application.delete({ where: { id: "application" } })).rejects.toMatchObject({ code: "P2003" });
    const nonces = await Promise.allSettled(Array.from({ length: 2 }, () =>
      db.agentNonce.create({ data: { deviceId: "device", nonce: "signed-request" } })));
    expect(nonces.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const oldKey = "test-public-key";
    await db.device.update({ where: { id: "device" }, data: { publicKeyPem: "rotated-public-key" } });
    const staleSignature = await db.device.updateMany({ where: { id: "device", revokedAt: null,
      publicKeyPem: oldKey }, data: { lastSeenAt: new Date() } });
    expect(staleSignature.count).toBe(0);
    await db.device.update({ where: { id: "device" }, data: { revokedAt: new Date() } });
    const denied = await db.updateJob.updateMany({ where: { id: "job", status: "queued",
      device: { revokedAt: null, executionMode: "update_enabled" } }, data: { status: "leased" } });
    expect(denied.count).toBe(0);
  });
});
