import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { PrismaClient } from "@updatepilot/db";
import { createApp } from "../src/app";

const deviceId = "device-1";
const createdAt = new Date("2026-10-20T12:00:00.000Z");

function fakeDb() {
  return {
    session: { findUnique: vi.fn().mockResolvedValue({
      userId: "local-owner", user: { username: "tester" }, csrfToken: "csrf-token",
      expiresAt: new Date(Date.now() + 60_000),
    }) },
    device: { findFirst: vi.fn().mockResolvedValue({ id: deviceId }) },
    scanJob: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(), updateMany: vi.fn(), findMany: vi.fn().mockResolvedValue([]),
    },
    auditEvent: { create: vi.fn() },
  };
}

function getLatest(db: ReturnType<typeof fakeDb>, cookie = true) {
  const call = request(createApp(db as unknown as PrismaClient))
    .get(`/api/v1/devices/${deviceId}/scans/latest`);
  return cookie ? call.set("Cookie", "up_session=opaque") : call;
}

describe("latest scan status", () => {
  it("requires an authenticated owner before looking up a device", async () => {
    const db = fakeDb();
    const response = await getLatest(db, false);
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("UNAUTHENTICATED");
    expect(db.device.findFirst).not.toHaveBeenCalled();
  });

  it("does not reveal a device outside the owner's active devices", async () => {
    const db = fakeDb();
    db.device.findFirst.mockResolvedValue(null);
    const response = await getLatest(db);
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("DEVICE_NOT_FOUND");
    expect(db.device.findFirst).toHaveBeenCalledWith({ where: {
      id: deviceId, ownerId: "local-owner", revokedAt: null,
    }, select: { id: true } });
    expect(db.scanJob.findFirst).not.toHaveBeenCalled();
  });

  it("returns null without changing state when an owner has not scanned yet", async () => {
    const db = fakeDb();
    const response = await getLatest(db);
    expect(response.status).toBe(200);
    expect(response.text).toBe("null");
    expect(db.scanJob.findFirst).toHaveBeenCalledWith({ where: { deviceId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    expect(db.scanJob.updateMany).not.toHaveBeenCalled();
    expect(db.auditEvent.create).not.toHaveBeenCalled();
  });

  it("returns the newest job in the existing typed status shape", async () => {
    const db = fakeDb();
    db.scanJob.findFirst.mockResolvedValue({ id: "scan-2", deviceId,
      status: "running", createdAt, startedAt: createdAt,
      completedAt: null, errorCode: null });
    const response = await getLatest(db);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: "scan-2", deviceId, status: "running",
      createdAt: createdAt.toISOString(), startedAt: createdAt.toISOString(),
      completedAt: null, errorCode: null });
    expect(db.scanJob.updateMany).not.toHaveBeenCalled();
  });

  it("reuses an active job when the owner requests another scan", async () => {
    const db = fakeDb();
    db.scanJob.findFirst.mockResolvedValue({ id: "scan-active", deviceId,
      status: "queued", createdAt, startedAt: null,
      completedAt: null, errorCode: null });
    const response = await request(createApp(db as unknown as PrismaClient))
      .post(`/api/v1/devices/${deviceId}/scans`)
      .set("Origin", "http://127.0.0.1:3000")
      .set("Cookie", "up_session=opaque")
      .set("X-CSRF-Token", "csrf-token")
      .send({});
    expect(response.status).toBe(202);
    expect(response.body.id).toBe("scan-active");
    expect(db.scanJob.create).not.toHaveBeenCalled();
    expect(db.auditEvent.create).not.toHaveBeenCalled();
  });
});
