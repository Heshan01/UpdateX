import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { PrismaClient } from "@updatepilot/db";
import { createApp } from "../src/app";

const origin = "http://127.0.0.1:3000";

function fakeDb() {
  const user = { id: "local-owner", username: "tester", passwordHash: "unused", accountEnabled: true };
  const db = {
    user: { count: vi.fn().mockResolvedValue(0), findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]), findUniqueOrThrow: vi.fn().mockResolvedValue(user),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue(user), upsert: vi.fn().mockResolvedValue({ ...user, accountEnabled: false }) },
    auditEvent: { create: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
    session: { create: vi.fn().mockResolvedValue({}), findUnique: vi.fn().mockResolvedValue(null) },
    device: { findFirst: vi.fn().mockResolvedValue(null) },
    scanSnapshot: { findFirst: vi.fn().mockResolvedValue(null) },
    application: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    settings: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue({ theme: "dark", retentionDays: 365, scanReminderDays: 7 }) },
    $transaction: vi.fn().mockImplementation(async callback => callback(db)),
  };
  return db;
}

describe("local API boundaries", () => {
  it("responds to the health check without connecting to PostgreSQL", async () => {
    const response = await request(createApp(fakeDb() as unknown as PrismaClient)).get("/api/v1/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(response.headers["x-request-id"]).toBeTruthy();
  });

  it("rejects state changes from an unrelated origin", async () => {
    const db = fakeDb();
    const response = await request(createApp(db as unknown as PrismaClient)).post("/api/v1/auth/bootstrap")
      .set("Origin", "https://elsewhere.example").send({ username: "tester", password: "a-strong-password" });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("ORIGIN_REJECTED");
    expect(db.user.count).not.toHaveBeenCalled();
  });

  it("requires authentication before returning inventory", async () => {
    const db = fakeDb();
    const response = await request(createApp(db as unknown as PrismaClient)).get("/api/v1/applications");
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("UNAUTHENTICATED");
    expect(db.device.findFirst).not.toHaveBeenCalled();
  });

  it("allows a local Guest session without creating a password account", async () => {
    const db = fakeDb();
    const response = await request(createApp(db as unknown as PrismaClient))
      .post("/api/v1/auth/guest").set("Origin", origin).send({});
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ authenticated: true, mode: "guest", accountAvailable: false });
    expect(response.body.csrfToken).toBeTruthy();
    expect(db.user.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "local-owner" } }));
  });

  it("registers a separate local account while retaining the shared inventory owner", async () => {
    const db = fakeDb();
    db.user.create.mockResolvedValue({ id: "account-two", username: "new-owner", accountEnabled: true });
    const response = await request(createApp(db as unknown as PrismaClient))
      .post("/api/v1/auth/register").set("Origin", origin)
      .send({ username: "new-owner", password: "A-long-local-passphrase-123" });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ authenticated: true, mode: "account", username: "new-owner" });
    expect(db.user.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "local-owner" } }));
    expect(db.session.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      userId: "account-two", mode: "account",
    }) }));
  });

  it("rejects an existing username without creating another account", async () => {
    const db = fakeDb();
    db.user.findMany.mockResolvedValue([{ id: "local-owner", username: "Existing", accountEnabled: true }]);
    const response = await request(createApp(db as unknown as PrismaClient))
      .post("/api/v1/auth/register").set("Origin", origin)
      .send({ username: "existing", password: "A-long-local-passphrase-123" });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("USERNAME_TAKEN");
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it("lets a signed-in additional account read the existing computer inventory", async () => {
    const db = fakeDb();
    db.session.findUnique.mockResolvedValue({ userId: "account-two", mode: "account",
      user: { username: "new-owner" }, csrfToken: "token", expiresAt: new Date(Date.now() + 60_000) });
    const response = await request(createApp(db as unknown as PrismaClient))
      .get("/api/v1/dashboard").set("Cookie", "up_session=opaque");
    expect(response.status).toBe(200);
    expect(db.device.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { ownerId: "local-owner", revokedAt: null },
    }));
  });

  it("validates first-run credentials before touching the database", async () => {
    const db = fakeDb();
    const response = await request(createApp(db as unknown as PrismaClient)).post("/api/v1/auth/bootstrap")
      .set("Origin", origin).send({ username: "x", password: "short" });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
    expect(db.user.count).not.toHaveBeenCalled();
  });

  it("creates a local owner session and enforces CSRF for settings", async () => {
    const db = fakeDb();
    const app = createApp(db as unknown as PrismaClient);
    const bootstrap = await request(app).post("/api/v1/auth/bootstrap").set("Origin", origin)
      .send({ username: "tester", password: "a-strong-password" });
    expect(bootstrap.status).toBe(201);
    expect(bootstrap.body.authenticated).toBe(true);
    expect(bootstrap.body.csrfToken).toBeTruthy();
    expect(bootstrap.headers["set-cookie"]?.[0]).toContain("HttpOnly");
    const session = { userId: "local-owner", user: { username: "tester" }, csrfToken: bootstrap.body.csrfToken, expiresAt: new Date(Date.now() + 60_000) };
    db.session.findUnique.mockResolvedValue(session);
    const cookie = bootstrap.headers["set-cookie"]?.[0].split(";")[0];
    const rejected = await request(app).patch("/api/v1/settings").set("Origin", origin).set("Cookie", cookie)
      .send({ theme: "dark" });
    expect(rejected.status).toBe(403);
    expect(rejected.body.code).toBe("CSRF_REJECTED");
    expect(db.settings.upsert).not.toHaveBeenCalled();
    const saved = await request(app).patch("/api/v1/settings").set("Origin", origin).set("Cookie", cookie)
      .set("X-CSRF-Token", bootstrap.body.csrfToken).send({ theme: "dark" });
    expect(saved.status).toBe(200);
    expect(saved.body.theme).toBe("dark");
    expect(db.settings.upsert).toHaveBeenCalledOnce();
  });

  it("filters Unicode-capable inventory search before stable pagination", async () => {
    const db = fakeDb();
    db.session.findUnique.mockResolvedValue({ userId: "local-owner", user: { username: "tester" }, csrfToken: "token", expiresAt: new Date(Date.now() + 60_000) });
    db.device.findFirst.mockResolvedValue({ id: "device-1" });
    db.scanSnapshot.findFirst.mockResolvedValue({ id: "scan-1" });
    const response = await request(createApp(db as unknown as PrismaClient))
      .get("/api/v1/applications?search=editor&match=verified&sort=name&page=2&pageSize=5")
      .set("Cookie", "up_session=opaque");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ items: [], page: 2, pageSize: 5, total: 0 });
    expect(db.application.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ snapshotId: "scan-1", matchStatus: "verified" }),
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
    }));
    const query = db.application.findMany.mock.calls[0][0];
    expect(query).not.toHaveProperty("skip");
    expect(query).not.toHaveProperty("take");
  });

  it("keeps saved inventory and dashboard status available after login while the agent is offline", async () => {
    const db = fakeDb();
    const takenAt = new Date("2026-10-20T12:00:00.000Z");
    db.session.findUnique.mockResolvedValue({ userId: "local-owner", user: { username: "tester" },
      csrfToken: "token", expiresAt: new Date(Date.now() + 60_000) });
    db.device.findFirst.mockResolvedValue({ id: "device-1", name: "PC", agentVersion: "0.2.0",
      osVersion: "Windows", lastSeenAt: new Date(Date.now() - 120_000), revokedAt: null });
    db.scanSnapshot.findFirst.mockResolvedValue({ id: "scan-1", takenAt });
    db.application.count.mockResolvedValueOnce(157).mockResolvedValueOnce(11).mockResolvedValueOnce(35).mockResolvedValueOnce(157);
    const api = createApp(db as unknown as PrismaClient);
    const dashboard = await request(api).get("/api/v1/dashboard").set("Cookie", "up_session=opaque");
    const inventory = await request(api).get("/api/v1/applications").set("Cookie", "up_session=opaque");
    expect(dashboard.status).toBe(200);
    expect(dashboard.body).toMatchObject({ inventoryCount: 157, updateCount: 11,
      lastScanAt: takenAt.toISOString(), agent: { connection: "offline" } });
    expect(inventory.status).toBe(200);
    expect(inventory.body.total).toBe(157);
    expect(db.scanSnapshot.findFirst).toHaveBeenCalledTimes(2);
  });
});
