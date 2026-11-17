import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { CookieOptions, RequestHandler, Response } from "express";
import { normalizedUsername, type Prisma, type PrismaClient } from "@updatepilot/db";
import { CredentialsSchema } from "@updatepilot/contracts";
import { config } from "./config";
import { ApiFailure, asyncRoute } from "./errors";

const COOKIE = "up_session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const cookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: config.SESSION_COOKIE_SECURE === "true" || process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_MS,
};

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function findAccountByUsername(db: PrismaClient | Prisma.TransactionClient, username: string) {
  const key = normalizedUsername(username);
  const accounts = await db.user.findMany();
  return accounts.find(account => normalizedUsername(account.username) === key) ?? null;
}

export function ownerId(res: Response): string {
  const id = res.locals.ownerId as string | undefined;
  if (!id) throw new ApiFailure(401, "UNAUTHENTICATED", "Choose Guest or sign in to continue.");
  return id;
}

async function createSession(db: PrismaClient, res: Response, userId: string, username: string, mode: "guest" | "account", accountAvailable: boolean) {
  const token = crypto.randomBytes(32).toString("base64url");
  const csrfToken = crypto.randomBytes(32).toString("base64url");
  await db.session.create({ data: { userId, tokenHash: tokenHash(token), csrfToken, mode, expiresAt: new Date(Date.now() + SESSION_MS) } });
  res.cookie(COOKIE, token, cookieOptions);
  return { initialized: accountAvailable, accountAvailable, authenticated: true,
    mode, username: mode === "guest" ? "Guest" : username, csrfToken };
}

export function authRoutes(db: PrismaClient) {
  const accountAvailable = () => Promise.resolve(true);

  const state: RequestHandler = asyncRoute(async (req, res) => {
    const available = true;
    const token = req.cookies?.[COOKIE] as string | undefined;
    if (!token) { res.json({ initialized: available, accountAvailable: available, authenticated: false }); return; }
    const session = await db.session.findUnique({ where: { tokenHash: tokenHash(token) }, include: { user: true } });
    if (!session || session.expiresAt <= new Date()) { res.json({ initialized: available, accountAvailable: available, authenticated: false }); return; }
    res.json({ initialized: available, accountAvailable: available, authenticated: true,
      mode: session.mode === "guest" ? "guest" : "account",
      username: session.mode === "guest" ? "Guest" : session.user.username, csrfToken: session.csrfToken });
  });

  const guest: RequestHandler = asyncRoute(async (_req, res) => {
    // Each guest has their own isolated user identity and settings
    const guestUser = await db.user.create({
      data: {
        username: `guest_${crypto.randomBytes(6).toString("hex")}`,
        passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString("base64url"), 10),
        accountEnabled: false,
        settings: { create: { theme: "system", retentionDays: 365 } },
      },
    });
    res.json(await createSession(db, res, guestUser.id, "Guest", "guest", true));
  });

  const register: RequestHandler = asyncRoute(async (req, res) => {
    const credentials = CredentialsSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(credentials.password, 12);
    try {
      const user = await db.$transaction(async tx => {
        if (await findAccountByUsername(tx, credentials.username))
          throw new ApiFailure(409, "USERNAME_TAKEN", "That username is already in use.");
        const created = await tx.user.create({
          data: {
            username: credentials.username,
            passwordHash,
            accountEnabled: true,
            settings: { create: { theme: "system", retentionDays: 365 } },
          },
        });
        await tx.auditEvent.create({
          data: { userId: created.id, action: "owner.created", detail: "Account created" },
        });
        return created;
      }, { isolationLevel: "Serializable" });
      res.status(201).json(await createSession(db, res, user.id, user.username, "account", true));
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002")
        throw new ApiFailure(409, "USERNAME_TAKEN", "That username is already in use.");
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2034")
        throw new ApiFailure(409, "REGISTRATION_CONFLICT", "Another account changed. Try again.");
      throw error;
    }
  });

  const bootstrap: RequestHandler = asyncRoute(async (req, res) => {
    // Multi-user registration
    const credentials = CredentialsSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(credentials.password, 12);
    try {
      const user = await db.$transaction(async tx => {
        if (await findAccountByUsername(tx, credentials.username))
          throw new ApiFailure(409, "USERNAME_TAKEN", "That username is already in use.");
        const created = await tx.user.create({
          data: {
            username: credentials.username,
            passwordHash,
            accountEnabled: true,
            settings: { create: { theme: "system", retentionDays: 365 } },
          },
        });
        await tx.auditEvent.create({
          data: { userId: created.id, action: "owner.created", detail: "Account created" },
        });
        return created;
      }, { isolationLevel: "Serializable" });
      res.status(201).json(await createSession(db, res, user.id, user.username, "account", true));
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
        throw new ApiFailure(409, "USERNAME_TAKEN", "That username is already in use.");
      }
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2034")
        throw new ApiFailure(409, "REGISTRATION_CONFLICT", "Another account changed. Try again.");
      throw error;
    }
  });

  const login: RequestHandler = asyncRoute(async (req, res) => {
    const credentials = CredentialsSchema.parse(req.body);
    const user = await findAccountByUsername(db, credentials.username);
    if (!user?.accountEnabled || !(await bcrypt.compare(credentials.password, user.passwordHash))) {
      throw new ApiFailure(401, "INVALID_CREDENTIALS", "Username or password is incorrect.");
    }
    await db.auditEvent.create({ data: { userId: user.id, action: "owner.signed_in", detail: "Signed in" } });
    res.json(await createSession(db, res, user.id, user.username, "account", true));
  });

  const requireOwner: RequestHandler = asyncRoute(async (req, res, next) => {
    const token = req.cookies?.[COOKIE] as string | undefined;
    if (!token) throw new ApiFailure(401, "UNAUTHENTICATED", "Choose Guest or sign in to continue.");
    const session = await db.session.findUnique({ where: { tokenHash: tokenHash(token) }, include: { user: true } });
    if (!session || session.expiresAt <= new Date()) throw new ApiFailure(401, "SESSION_EXPIRED", "Your session expired. Sign in again.");
    // Isolated per-user scoping
    res.locals.ownerId = session.userId;
    res.locals.username = session.mode === "guest" ? "Guest" : session.user.username;
    res.locals.accessMode = session.mode === "guest" ? "guest" : "account";
    res.locals.csrfToken = session.csrfToken;
    next();
  });

  const requireCsrf: RequestHandler = (req, res, next) => {
    const expected = res.locals.csrfToken as string | undefined;
    const actual = req.header("X-CSRF-Token") ?? "";
    if (!expected || !equalSecret(expected, actual)) return next(new ApiFailure(403, "CSRF_REJECTED", "Refresh the page and try again."));
    next();
  };

  const logout: RequestHandler = asyncRoute(async (req, res) => {
    const token = req.cookies?.[COOKIE] as string | undefined;
    if (token) await db.session.deleteMany({ where: { tokenHash: tokenHash(token) } });
    res.clearCookie(COOKIE, { ...cookieOptions, maxAge: undefined });
    res.status(204).end();
  });

  return { state, guest, register, bootstrap, login, requireOwner, requireCsrf, logout };
}
