import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { PrismaClient } from "@updatepilot/db";
import { createApp } from "../src/app";

const deviceId = "c123456789012345678901234";
const sourceKeys = ["a".repeat(64), "b".repeat(64)];

function scanPayload() {
  return { status: "succeeded", rawObservationCount: 2, errorCode: null,
    applications: [{
      stableKey: "c".repeat(64), displayName: "Git", publisher: "The Git Development Community",
      installedVersion: "2.54.0", packageId: "Git.Git", source: "winget",
      availableVersion: "2.55.0.5", matchStatus: "verified", updateStatus: "available",
      matchReason: "Exact installed identity", evidenceType: "registry", installScope: "machine",
      architecture: "x64", installLocation: "C:\\Program Files\\Git", installationType: "desktop",
      observations: [{ sourceKey: sourceKeys[0], evidenceType: "registry", displayName: "Git",
        publisher: "The Git Development Community", installedVersion: "2.54.0", packageId: null,
        registryHive: "LocalMachine", registryView: "Registry64", registryKey: "Git",
        installLocation: "C:\\Program Files\\Git", displayIcon: null,
        architecture: "x64", installScope: "machine", windowsInstaller: false },
      { sourceKey: sourceKeys[1], evidenceType: "winget", displayName: "Git",
        publisher: null, installedVersion: "2.54.0", packageId: "Git.Git",
        registryHive: null, registryView: null, registryKey: null,
        installLocation: null, displayIcon: null, architecture: null,
        installScope: null, windowsInstaller: null }],
    }] };
}

function fakeDb(publicKeyPem: string) {
  const snapshots: { id: string; scanJobId: string; rawObservationCount: number }[] = [];
  const applications: { id: string; snapshotId: string; stableKey: string }[] = [];
  const observations: { applicationId: string; sourceKey: string }[] = [];
  const db = {
    device: { findUnique: vi.fn().mockResolvedValue({ id: deviceId, ownerId: "owner",
      publicKeyPem, revokedAt: null }), update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    agentNonce: { create: vi.fn().mockResolvedValue({}) },
    scanJob: { findFirst: vi.fn().mockImplementation(({ where }) => Promise.resolve({
      id: where.id, deviceId, requestedBy: "owner", status: "running",
      leaseUntil: new Date(Date.now() + 120_000) })),
      update: vi.fn().mockImplementation(({ where, data }) => Promise.resolve({
        id: where.id, deviceId, status: data.status, createdAt: new Date(),
        startedAt: new Date(), completedAt: data.completedAt, errorCode: null })) },
    scanSnapshot: { create: vi.fn().mockImplementation(({ data }) => {
      const snapshot = { id: `snapshot-${snapshots.length + 1}`, scanJobId: data.scanJobId,
        rawObservationCount: data.rawObservationCount };
      snapshots.push(snapshot); return Promise.resolve(snapshot);
    }) },
    application: { createMany: vi.fn().mockImplementation(({ data }) => {
      for (const item of data) applications.push({ id: `app-${applications.length + 1}`,
        snapshotId: item.snapshotId, stableKey: item.stableKey });
      return Promise.resolve({ count: data.length });
    }), findMany: vi.fn().mockImplementation(({ where }) => Promise.resolve(
      applications.filter(item => item.snapshotId === where.snapshotId))),
      findFirst: vi.fn() },
    applicationObservation: { createMany: vi.fn().mockImplementation(({ data }) => {
      observations.push(...data); return Promise.resolve({ count: data.length });
    }) },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
    session: { findUnique: vi.fn().mockResolvedValue({ userId: "owner",
      user: { username: "tester" }, csrfToken: "csrf", expiresAt: new Date(Date.now() + 60_000) }) },
    $transaction: vi.fn().mockImplementation(async callback => callback(db)),
  };
  return { db, snapshots, applications, observations };
}

function signedScan(app: ReturnType<typeof createApp>, jobId: string, body: unknown,
  privateKey: crypto.KeyObject) {
  const path = `/api/v1/agent/scans/${jobId}/result`;
  const payload = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(24).toString("base64url");
  const message = ["POST", path, crypto.createHash("sha256").update(payload).digest("hex"),
    deviceId, timestamp, nonce].join("\n");
  const signature = crypto.sign("sha256", Buffer.from(message),
    { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return request(app).post(path).set("X-UP-Device-Id", deviceId)
    .set("X-UP-Timestamp", timestamp).set("X-UP-Nonce", nonce)
    .set("X-UP-Signature", signature).set("Content-Type", "application/json").send(payload);
}

describe("scan snapshot persistence", () => {
  it("persists one logical row and both source observations on each repeated scan", async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const { db, snapshots, applications, observations } = fakeDb(
      publicKey.export({ type: "spki", format: "pem" }).toString());
    const api = createApp(db as unknown as PrismaClient);
    const body = scanPayload();
    const first = await signedScan(api, "scan-1", body, privateKey);
    const second = await signedScan(api, "scan-2", body, privateKey);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map(item => item.rawObservationCount)).toEqual([2, 2]);
    expect(applications).toHaveLength(2);
    expect(applications[0].stableKey).toBe(applications[1].stableKey);
    expect(applications[0].snapshotId).not.toBe(applications[1].snapshotId);
    expect(observations).toHaveLength(4);
    expect(new Set(observations.map(item => item.applicationId)).size).toBe(2);
    expect(db.application.createMany).toHaveBeenCalledTimes(2);
  });

  it("rejects duplicate raw source identities before writing a snapshot", async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const { db } = fakeDb(publicKey.export({ type: "spki", format: "pem" }).toString());
    const body = scanPayload();
    body.applications[0].observations[1].sourceKey = sourceKeys[0];
    const response = await signedScan(createApp(db as unknown as PrismaClient),
      "scan-invalid", body, privateKey);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
    expect(db.scanSnapshot.create).not.toHaveBeenCalled();
  });

  it("returns the installation's source provenance without losing trusted metadata", async () => {
    const { publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const { db } = fakeDb(publicKey.export({ type: "spki", format: "pem" }).toString());
    const input = scanPayload().applications[0];
    db.application.findFirst.mockResolvedValue({ id: "app-1", ...input,
      observedAt: new Date(), snapshot: { deviceId },
      _count: { observations: 2 },
      observations: input.observations.map(observation => ({ ...observation })) });
    const response = await request(createApp(db as unknown as PrismaClient))
      .get("/api/v1/applications/app-1").set("Cookie", "up_session=opaque");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ displayName: "Git", publisher: "The Git Development Community",
      installedVersion: "2.54.0", packageId: "Git.Git", observationCount: 2 });
    expect(response.body.observations).toHaveLength(2);
    expect(response.body.observations.map((item: { evidenceType: string }) => item.evidenceType))
      .toEqual(["registry", "winget"]);
  });
});
