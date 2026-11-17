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
  sameSite: "strict",
  secure: config.SESSION_COOKIE_SECURE === "true",
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
  const accountAvailable = () => db.user.count({ where: { accountEnabled: true } }).then(count => count > 0);
  const ensureLocalOwner = async () => db.user.upsert({ where: { id: "local-owner" }, update: {}, create: {
    id: "local-owner", username: "__updatex_guest__",
    passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString("base64url"), 12),
    accountEnabled: false, settings: { create: { theme: "system", retentionDays: 365 } },
  } });
  const state: RequestHandler = asyncRoute(async (req, res) => {
    const available = await accountAvailable();
    const token = req.cookies?.[COOKIE] as string | undefined;
    if (!token) { res.json({ initialized: available, accountAvailable: available, authenticated: false }); return; }
    const session = await db.session.findUnique({ where: { tokenHash: tokenHash(token) }, include: { user: true } });
    if (!session || session.expiresAt <= new Date()) { res.json({ initialized: available, accountAvailable: available, authenticated: false }); return; }
    res.json({ initialized: available, accountAvailable: available, authenticated: true,
      mode: session.mode === "guest" ? "guest" : "account",
      username: session.mode === "guest" ? "Guest" : session.user.username, csrfToken: session.csrfToken });
  });

  const guest: RequestHandler = asyncRoute(async (_req, res) => {
    // All guests and the optional local account share one data owner. This keeps
    // existing devices, snapshots, jobs and history when the user creates an account.
    const user = await ensureLocalOwner();
    res.json(await createSession(db, res, user.id, user.username, "guest", await accountAvailable()));
  });

  const register: RequestHandler = asyncRoute(async (req, res) => {
    const credentials = CredentialsSchema.parse(req.body);
    const owner = await ensureLocalOwner();
    const passwordHash = await bcrypt.hash(credentials.password, 12);
    try {
      const user = await db.$transaction(async tx => {
        if (await findAccountByUsername(tx, credentials.username))
          throw new ApiFailure(409, "USERNAME_TAKEN", "That username is already in use on this computer.");
        const created = await tx.user.create({ data: {
          username: credentials.username, passwordHash, accountEnabled: true,
        } });
        await tx.auditEvent.create({ data: { userId: owner.id, action: "owner.created", detail: "Local account created" } });
        return created;
      }, { isolationLevel: "Serializable" });
      res.status(201).json(await createSession(db, res, user.id, user.username, "account", true));
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002")
        throw new ApiFailure(409, "USERNAME_TAKEN", "That username is already in use on this computer.");
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2034")
        throw new ApiFailure(409, "REGISTRATION_CONFLICT", "Another account changed. Try again.");
      throw error;
    }
  });

  const bootstrap: RequestHandler = asyncRoute(async (req, res) => {
    const credentials = CredentialsSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(credentials.password, 12);
    try {
      const user = await db.$transaction(async tx => {
        const sameName = await findAccountByUsername(tx, credentials.username);
        if (await tx.user.count({ where: { accountEnabled: true } }) ||
            (sameName && sameName.id !== "local-owner"))
          throw new ApiFailure(409, "ALREADY_INITIALIZED", "A local account already exists.");
        const existing = await tx.user.findUnique({ where: { id: "local-owner" } });
        if (existing?.accountEnabled) throw new ApiFailure(409, "ALREADY_INITIALIZED", "The local account already exists.");
        if (existing) {
          const changed = await tx.user.updateMany({ where: { id: existing.id, accountEnabled: false }, data: {
            username: credentials.username, passwordHash, accountEnabled: true,
          } });
          if (changed.count !== 1) throw new ApiFailure(409, "ALREADY_INITIALIZED", "The local account already exists.");
        }
        const created = existing ? await tx.user.findUniqueOrThrow({ where: { id: existing.id } }) : await tx.user.create({ data: {
          id: "local-owner", username: credentials.username, passwordHash, accountEnabled: true,
          settings: { create: { theme: "system", retentionDays: 365 } },
        } });
        await tx.auditEvent.create({ data: { userId: created.id, action: "owner.created", detail: "Local owner account created" } });
        return created;
      }, { isolationLevel: "Serializable" });
      res.status(201).json(await createSession(db, res, user.id, user.username, "account", true));
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
        throw new ApiFailure(409, "ALREADY_INITIALIZED", "The owner account already exists.");
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
    await db.auditEvent.create({ data: { userId: "local-owner", action: "owner.signed_in", detail: "Local account signed in" } });
    res.json(await createSession(db, res, user.id, user.username, "account", true));
  });

  const requireOwner: RequestHandler = asyncRoute(async (req, res, next) => {
    const token = req.cookies?.[COOKIE] as string | undefined;
    if (!token) throw new ApiFailure(401, "UNAUTHENTICATED", "Choose Guest or sign in to continue.");
    const session = await db.session.findUnique({ where: { tokenHash: tokenHash(token) }, include: { user: true } });
    if (!session || session.expiresAt <= new Date()) throw new ApiFailure(401, "SESSION_EXPIRED", "Your session expired. Sign in again.");
    // Every mode accesses the same licensed computer's inventory and history.
    // The authenticated account identity stays in Session for sign-in and sign-out.
    res.locals.ownerId = "local-owner";
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
