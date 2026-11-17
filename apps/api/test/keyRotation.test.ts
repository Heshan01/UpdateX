import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { PrismaClient } from "@updatepilot/db";
import { createApp } from "../src/app";

const deviceId = "c123456789012345678901234";
const pairingId = "c123456789012345678901235";
const origin = "http://127.0.0.1:3000";

function signedHeartbeat(app: ReturnType<typeof createApp>, privateKey: crypto.KeyObject) {
  const path = "/api/v1/agent/heartbeat";
  const body = JSON.stringify({ executionMode: "read_only" });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(24).toString("base64url");
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  const message = ["POST", path, bodyHash, deviceId, timestamp, nonce].join("\n");
  const signature = crypto.sign("sha256", Buffer.from(message),
    { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return request(app).post(path).set("X-UP-Device-Id", deviceId)
    .set("X-UP-Timestamp", timestamp).set("X-UP-Nonce", nonce)
    .set("X-UP-Signature", signature).set("Content-Type", "application/json").send(body);
}

describe("owner-approved agent key replacement", () => {
  it("keeps the device and its history while invalidating the old signing key", async () => {
    const oldKeys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const newKeys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const oldPem = oldKeys.publicKey.export({ type: "spki", format: "pem" });
    const newPem = newKeys.publicKey.export({ type: "spki", format: "pem" });
    const fingerprint = crypto.createHash("sha256").update(newKeys.publicKey.export({ type: "spki", format: "der" })).digest("hex");
    const device = { id: deviceId, ownerId: "local-owner", name: "TEST-PC", revokedAt: null,
      lastSeenAt: new Date(Date.now() - 120_000), lastHeartbeatAt: new Date(Date.now() - 120_000), executionMode: "read_only",
      keyFingerprint: "a".repeat(64), publicKeyPem: oldPem };
    const pairing = { id: pairingId, keyFingerprint: fingerprint, publicKeyPem: newPem,
      deviceName: "TEST-PC", agentVersion: "0.2.0", osVersion: "Windows",
      approvedAt: null as Date | null, deviceId: null as string | null,
      expiresAt: new Date(Date.now() + 120_000) };
    const db = {
      session: { findUnique: vi.fn().mockResolvedValue({ userId: "local-owner", user: { username: "tester" },
        csrfToken: "csrf-token", expiresAt: new Date(Date.now() + 120_000) }) },
      device: { findFirst: vi.fn().mockResolvedValue(device), findUnique: vi.fn().mockImplementation(() => Promise.resolve(device)),
        updateMany: vi.fn().mockImplementation(({ data }) => { Object.assign(device, data); return Promise.resolve({ count: 1 }); }),
        update: vi.fn().mockResolvedValue(device) },
      pairingRequest: { findUnique: vi.fn().mockResolvedValue(pairing), updateMany: vi.fn().mockImplementation(({ data }) => {
        Object.assign(pairing, data); return Promise.resolve({ count: 1 });
      }) },
      updateJob: { count: vi.fn().mockResolvedValue(0) },
      scanJob: { count: vi.fn().mockResolvedValue(0) },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
      agentNonce: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn().mockImplementation(async fn => fn(db)),
    };
    const api = createApp(db as unknown as PrismaClient);
    const rotated = await request(api).post(`/api/v1/devices/${deviceId}/rotate-key`)
      .set("Origin", origin).set("Cookie", "up_session=opaque").set("X-CSRF-Token", "csrf-token")
      .send({ code: "ABCDEF-GHJKLM", fingerprint });
    expect(rotated.status).toBe(200);
    expect(rotated.body.deviceId).toBe(deviceId);
    expect(db.device.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ publicKeyPem: newPem, executionMode: "read_only", lastSeenAt: null,
        lastHeartbeatAt: null }),
    }));
    expect(db.scanJob.count).toHaveBeenCalledOnce();
    const rejectedOld = await signedHeartbeat(api, oldKeys.privateKey);
    expect(rejectedOld.status).toBe(401);
    expect(rejectedOld.body.code).toBe("AGENT_SIGNATURE_INVALID");
    const acceptedNew = await signedHeartbeat(api, newKeys.privateKey);
    expect(acceptedNew.status).toBe(200);
    expect(db.auditEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "agent.key_rotated" }) });
  });
});
