import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { PrismaClient } from "@updatepilot/db";
import { createApp } from "../src/app";

const origin = "http://127.0.0.1:3000";
const deviceId = "c123456789012345678901234";
const previewId = "cm00000000000000000000000";
const future = new Date(Date.now() + 120_000);

function fakeDb() {
  const device = { id: deviceId, ownerId: "local-owner", revokedAt: null, lastSeenAt: new Date(),
    lastHeartbeatAt: new Date(), executionMode: "update_enabled" };
  const app = {
    id: "app-1", snapshotId: "snapshot-1", stableKey: "a".repeat(64),
    packageId: "Git.Git", source: "winget", publisher: "The Git Development Community",
    installedVersion: "2.54.0", availableVersion: "2.55.0.5",
    matchStatus: "verified", updateStatus: "available",
    snapshot: { id: "snapshot-1", deviceId, takenAt: new Date(Date.now() - 60_000), device },
  };
  const db = {
    user: { count: vi.fn() },
    settings: { findUnique: vi.fn().mockResolvedValue({ scanReminderDays: 7 }) },
    session: { findUnique: vi.fn().mockResolvedValue({ userId: "local-owner", user: { username: "tester" },
      csrfToken: "csrf-token", expiresAt: future }) },
    application: { findFirst: vi.fn().mockResolvedValue(app) },
    scanSnapshot: { findFirst: vi.fn().mockResolvedValue({ id: "snapshot-1" }) },
    updatePreview: { create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ ...data, id: previewId })),
      findFirst: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    updateJob: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn(),
      count: vi.fn().mockResolvedValue(0), create: vi.fn(), updateMany: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]), findUniqueOrThrow: vi.fn() },
    updateEvent: { create: vi.fn().mockResolvedValue({}) },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
    device: { findUnique: vi.fn().mockResolvedValue(device), update: vi.fn().mockResolvedValue(device),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    scanJob: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({ id: "post-update-scan" }), updateMany: vi.fn() },
    agentNonce: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn().mockImplementation(async fn => fn(db)),
  };
  return { db, app, device };
}

function ownerPost(app: ReturnType<typeof createApp>, path: string, body: unknown, csrf = true) {
  const call = request(app).post(`/api/v1${path}`).set("Origin", origin)
    .set("Cookie", "up_session=opaque").send(body);
  return csrf ? call.set("X-CSRF-Token", "csrf-token") : call;
}

function signedAgentPost(app: ReturnType<typeof createApp>, path: string, body: unknown,
  privateKey: crypto.KeyObject, nonce = crypto.randomBytes(24).toString("base64url")) {
  const payload = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message = ["POST", path, crypto.createHash("sha256").update(payload).digest("hex"),
    deviceId, timestamp, nonce].join("\n");
  const signature = crypto.sign("sha256", Buffer.from(message),
    { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return request(app).post(path).set("X-UP-Device-Id", deviceId)
    .set("X-UP-Timestamp", timestamp).set("X-UP-Nonce", nonce)
    .set("X-UP-Signature", signature).set("Content-Type", "application/json").send(payload);
}

describe("Day 2 update safety gates", () => {
  it("requires owner CSRF before generating a preview", async () => {
    const { db } = fakeDb();
    const response = await ownerPost(createApp(db as unknown as PrismaClient),
      "/applications/app-1/preview", {}, false);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("CSRF_REJECTED");
    expect(db.application.findFirst).not.toHaveBeenCalled();
  });

  it("refuses ambiguous package evidence and disconnected agents", async () => {
    const { db, app, device } = fakeDb();
    db.application.findFirst.mockResolvedValueOnce({ ...app, matchStatus: "ambiguous" });
    const api = createApp(db as unknown as PrismaClient);
    const ambiguous = await ownerPost(api, "/applications/app-1/preview", {});
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.code).toBe("UPDATE_NOT_ELIGIBLE");
    db.application.findFirst.mockResolvedValueOnce({ ...app, snapshot: { ...app.snapshot,
      device: { ...device, lastSeenAt: new Date(Date.now() - 120_000),
        lastHeartbeatAt: new Date(Date.now() - 120_000) } } });
    const offline = await ownerPost(api, "/applications/app-1/preview", {});
    expect(offline.status).toBe(409);
    expect(offline.body.code).toBe("AGENT_OFFLINE");
    expect(db.updatePreview.create).not.toHaveBeenCalled();
  });

  it("creates an exact expiring preview for current verified evidence", async () => {
    const { db } = fakeDb();
    const response = await ownerPost(createApp(db as unknown as PrismaClient),
      "/applications/app-1/preview", {});
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ packageId: "Git.Git", publisher: "The Git Development Community",
      installedVersion: "2.54.0", targetVersion: "2.55.0.5" });
    expect(response.body.warnings).toHaveLength(3);
    expect(db.updatePreview.create).toHaveBeenCalledOnce();
  });

  it("requires a fresh scan before reusing package evidence after execution", async () => {
    const { db } = fakeDb();
    db.updateJob.findFirst.mockResolvedValueOnce({ id: "prior-executed-update" });
    const response = await ownerPost(createApp(db as unknown as PrismaClient),
      "/applications/app-1/preview", {});
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("RESCAN_REQUIRED");
    expect(db.updatePreview.create).not.toHaveBeenCalled();
  });

  it("requires an explicit true confirmation before a job is created", async () => {
    const { db } = fakeDb();
    const response = await ownerPost(createApp(db as unknown as PrismaClient), "/updates/execute", {
      previewId, confirmation: false, idempotencyKey: crypto.randomUUID(),
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
    expect(db.updateJob.create).not.toHaveBeenCalled();
  });

  it("never queues an installation while the authenticated agent reports read-only mode", async () => {
    const { db, app, device } = fakeDb();
    const api = createApp(db as unknown as PrismaClient);
    await ownerPost(api, "/applications/app-1/preview", {});
    const evidence = db.updatePreview.create.mock.calls[0][0].data;
    db.updatePreview.findFirst.mockResolvedValue({ ...evidence, id: previewId, consumedAt: null, expiresAt: future });
    db.application.findFirst.mockResolvedValue({ ...app, snapshot: { ...app.snapshot,
      device: { ...device, executionMode: "read_only" } } });
    const response = await ownerPost(api, "/updates/execute", { previewId, confirmation: true,
      idempotencyKey: crypto.randomUUID() });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("AGENT_READ_ONLY");
    expect(db.updateJob.create).not.toHaveBeenCalled();
    expect(db.updatePreview.updateMany).not.toHaveBeenCalled();
  });

  it("allows the owner to cancel only an unclaimed queued job", async () => {
    const { db } = fakeDb();
    const queued = { id: "job-1", requestedBy: "local-owner", deviceId, applicationId: "app-1",
      status: "queued", packageId: "Git.Git", source: "winget", installedVersion: "2.54.0",
      targetVersion: "2.55.0.5", observedVersion: null, exitCode: null, diagnosticCode: null,
      createdAt: new Date(), startedAt: null, completedAt: null };
    db.updateJob.findFirst.mockResolvedValue(queued);
    db.updateJob.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    db.updateJob.findUniqueOrThrow.mockResolvedValue({ ...queued, status: "cancelled", completedAt: new Date(), diagnosticCode: "OWNER_CANCELLED" });
    const api = createApp(db as unknown as PrismaClient);
    const first = await ownerPost(api, "/jobs/job-1/cancel", {});
    const second = await ownerPost(api, "/jobs/job-1/cancel", {});
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("cancelled");
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("JOB_ALREADY_CLAIMED");
    expect(db.updateEvent.create).toHaveBeenCalledOnce();
  });

  it("expires an unclaimed job after bounded waiting without claiming execution", async () => {
    const { db } = fakeDb();
    const stale = { id: "job-old", deviceId, packageId: "Git.Git", requestedBy: "local-owner" };
    db.updateJob.findMany.mockResolvedValueOnce([stale]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    db.updateJob.updateMany.mockResolvedValue({ count: 1 });
    const response = await request(createApp(db as unknown as PrismaClient))
      .get("/api/v1/jobs").set("Cookie", "up_session=opaque");
    expect(response.status).toBe(200);
    expect(db.updateJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "job-old", status: "queued" }),
      data: expect.objectContaining({ status: "expired", diagnosticCode: "QUEUE_WAIT_EXPIRED" }),
    }));
    expect(db.updateEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: "expired" }) });
  });

  it("renews only a currently leased update and rejects a read-only claim", async () => {
    const { db, device } = fakeDb();
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    db.device.findUnique.mockResolvedValue({ ...device, executionMode: "read_only",
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) });
    db.updateJob.updateMany.mockResolvedValue({ count: 1 });
    const api = createApp(db as unknown as PrismaClient);
    const claim = await signedAgentPost(api, "/api/v1/agent/updates/job-1/claim", {}, privateKey);
    const renew = await signedAgentPost(api, "/api/v1/agent/updates/job-1/renew", {}, privateKey);
    expect(claim.status).toBe(409);
    expect(claim.body.code).toBe("AGENT_READ_ONLY");
    expect(renew.status).toBe(200);
    expect(renew.body.leaseUntil).toBeTruthy();
    expect(db.updateJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ["leased", "running", "verifying"] } }),
    }));
  });

  it("renews a running scan lease only for the signed paired device", async () => {
    const { db, device } = fakeDb();
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    db.device.findUnique.mockResolvedValue({ ...device,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) });
    db.scanJob.updateMany.mockResolvedValue({ count: 1 });
    const response = await signedAgentPost(createApp(db as unknown as PrismaClient),
      "/api/v1/agent/scans/scan-1/renew", {}, privateKey);
    expect(response.status).toBe(200);
    expect(db.scanJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ deviceId, status: "running", leaseUntil: { gt: expect.any(Date) } }),
    }));
  });

  it("classifies an interrupted claimed update as uncertain without requeueing it", async () => {
    const { db } = fakeDb();
    const interrupted = { id: "job-interrupted", deviceId, packageId: "Git.Git",
      requestedBy: "local-owner", status: "running" };
    db.updateJob.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([interrupted]).mockResolvedValueOnce([]);
    db.updateJob.updateMany.mockResolvedValue({ count: 1 });
    const response = await request(createApp(db as unknown as PrismaClient))
      .get("/api/v1/jobs").set("Cookie", "up_session=opaque");
    expect(response.status).toBe(200);
    expect(db.updateJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "job-interrupted", status: "running" }),
      data: expect.objectContaining({ status: "execution_unknown", leaseUntil: null }),
    }));
    expect(db.updateEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: "execution_unknown" }) });
    expect(db.updateJob.create).not.toHaveBeenCalled();
  });

  it("queues one confirmed job and returns it for a repeated idempotency key", async () => {
    const { db } = fakeDb();
    const api = createApp(db as unknown as PrismaClient);
    await ownerPost(api, "/applications/app-1/preview", {});
    const evidence = db.updatePreview.create.mock.calls[0][0].data;
    db.updatePreview.findFirst.mockResolvedValue({ ...evidence, id: previewId,
      consumedAt: null, expiresAt: future });
    const key = crypto.randomUUID();
    let created: Record<string, unknown>;
    db.updateJob.create.mockImplementation(({ data }) => {
      created = { ...data, id: "job-1", status: "queued", createdAt: new Date(),
        startedAt: null, completedAt: null, observedVersion: null,
        exitCode: null, diagnosticCode: null };
      return Promise.resolve(created);
    });
    db.updateJob.findUnique.mockResolvedValueOnce(null).mockImplementation(() => Promise.resolve(created));
    const body = { previewId, confirmation: true, idempotencyKey: key };
    const first = await ownerPost(api, "/updates/execute", body);
    const repeat = await ownerPost(api, "/updates/execute", body);
    expect(first.status).toBe(202);
    expect(repeat.status).toBe(202);
    expect(first.body.id).toBe("job-1");
    expect(repeat.body.id).toBe("job-1");
    expect(db.updateJob.create).toHaveBeenCalledOnce();
    expect(db.updateEvent.create).toHaveBeenCalledOnce();
    expect(db.auditEvent.create).toHaveBeenCalledOnce();
  });

  it("rejects an agent success claim when the approved target was not observed", async () => {
    const { db, device } = fakeDb();
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    db.device.findUnique.mockResolvedValue({ ...device, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) });
    db.updateJob.findFirst.mockResolvedValue({ id: "job-1", deviceId, status: "running",
      leaseUntil: future, executionStartedAt: new Date(), targetVersion: "2.55.0.5" });
    const path = "/api/v1/agent/updates/job-1/result";
    const payload = { status: "succeeded", observedVersion: "2.54.0", exitCode: 0,
      diagnosticCode: null, executionStarted: true };
    const response = await signedAgentPost(createApp(db as unknown as PrismaClient),
      path, payload, privateKey);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("VERSION_NOT_VERIFIED");
    expect(db.updateJob.updateMany).not.toHaveBeenCalled();
  });

  it("records a signed verifying transition after a running update", async () => {
    const { db, device } = fakeDb();
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    db.device.findUnique.mockResolvedValue({ ...device,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) });
    db.updateJob.updateMany.mockResolvedValue({ count: 1 });
    const response = await signedAgentPost(createApp(db as unknown as PrismaClient),
      "/api/v1/agent/updates/job-1/verifying", {}, privateKey);
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("verifying");
    expect(db.updateJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ deviceId, status: "running",
        executionStartedAt: { not: null } }),
      data: expect.objectContaining({ status: "verifying", progressStage: null,
        downloadPercent: null, downloadedBytes: null, totalBytes: null,
        progressAt: expect.any(Date) }),
    }));
    expect(db.updateEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      status: "verifying", detail: expect.stringContaining("checking the installed version"),
    }) });
  });

  for (const outcome of ["succeeded", "failed"] as const) {
    it(`persists the signed ${outcome} result and update history`, async () => {
      const { db, device } = fakeDb();
      const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      db.device.findUnique.mockResolvedValue({ ...device,
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) });
      const job = { id: "job-1", deviceId, applicationId: "app-1", requestedBy: "local-owner",
        status: outcome === "succeeded" ? "verifying" : "running", packageId: "Git.Git",
        source: "winget", installedVersion: "2.54.0", targetVersion: "2.55.0.5",
        observedVersion: null, exitCode: null, diagnosticCode: null, createdAt: new Date(),
        startedAt: new Date(), completedAt: null, executionStartedAt: new Date(), leaseUntil: future };
      const payload = outcome === "succeeded"
        ? { status: outcome, observedVersion: "2.55.0.5", exitCode: 0, diagnosticCode: null, executionStarted: true }
        : { status: outcome, observedVersion: null, exitCode: 1, diagnosticCode: "WINGET_EXIT_NONZERO", executionStarted: true };
      db.updateJob.findFirst.mockResolvedValue(job);
      db.updateJob.updateMany.mockResolvedValue({ count: 1 });
      db.updateJob.findUniqueOrThrow.mockResolvedValue({ ...job, ...payload, completedAt: new Date() });
      const response = await signedAgentPost(createApp(db as unknown as PrismaClient),
        "/api/v1/agent/updates/job-1/result", payload, privateKey);
      expect(response.status).toBe(200);
      expect(response.body.status).toBe(outcome);
      expect(db.updateJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: outcome, observedVersion: payload.observedVersion,
          exitCode: payload.exitCode, completedAt: expect.any(Date), leaseUntil: null }),
      }));
      expect(db.updateEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: outcome }) });
      expect(db.auditEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: `update.${outcome}` }) });
      expect(db.scanJob.create).toHaveBeenCalledWith({ data: { deviceId, requestedBy: "local-owner" } });
    });
  }

  it("rejects a replayed signed agent request", async () => {
    const { db, device } = fakeDb();
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    db.device.findUnique.mockResolvedValue({ ...device,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) });
    db.agentNonce.create.mockResolvedValueOnce({}).mockRejectedValueOnce({ code: "P2002" });
    const api = createApp(db as unknown as PrismaClient);
    const path = "/api/v1/agent/heartbeat";
    const nonce = crypto.randomBytes(24).toString("base64url");
    const first = await signedAgentPost(api, path, { executionMode: "read_only" }, privateKey, nonce);
    const replay = await signedAgentPost(api, path, { executionMode: "read_only" }, privateKey, nonce);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe("AGENT_REPLAY");
  });

  it("rejects a revoked agent before accepting a signed request", async () => {
    const { db, device } = fakeDb();
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    db.device.findUnique.mockResolvedValue({ ...device, revokedAt: new Date(),
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) });
    const response = await signedAgentPost(createApp(db as unknown as PrismaClient),
      "/api/v1/agent/heartbeat", {}, privateKey);
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("AGENT_REVOKED");
    expect(db.agentNonce.create).not.toHaveBeenCalled();
  });

  it("rejects a signed request if the agent key changes after signature verification", async () => {
    const { db, device } = fakeDb();
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    db.device.findUnique.mockResolvedValue({ ...device,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) });
    db.device.updateMany.mockResolvedValue({ count: 0 });
    const response = await signedAgentPost(createApp(db as unknown as PrismaClient),
      "/api/v1/agent/heartbeat", { executionMode: "read_only" }, privateKey);
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("AGENT_REVOKED");
    expect(db.device.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: deviceId, revokedAt: null,
        publicKeyPem: expect.any(String) }),
    }));
  });
});
