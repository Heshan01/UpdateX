import fs from "node:fs";
import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import type { PrismaClient } from "@updatepilot/db";
import { config } from "./config";
import { authRoutes } from "./auth";
import { dataRoutes } from "./data";
import { agentRoutes, ownerAgentRoutes } from "./day2";
import { storeRawBody } from "./agentSecurity";
import { ownerUpdateRoutes } from "./updateWorkflow";
import { ApiFailure, asyncRoute, errorHandler, requestId } from "./errors";
import { packagedLicenseGate } from "./licenseGate";
import { activateLocalLicense } from "./localLicense";

const attempts = new Map<string, { count: number; reset: number }>();

export function createApp(db: PrismaClient) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "2mb", verify: (req, _res, body) => { storeRawBody(req, body); } }));
  app.use(cookieParser());
  app.use(requestId);
  app.use(packagedLicenseGate);
  app.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  app.use((req, _res, next) => {
    const mutation = ["POST", "PATCH", "PUT", "DELETE"].includes(req.method);
    const agentWithoutOrigin = req.path.startsWith("/api/v1/agent/") && !req.header("Origin");
    const allowed = new Set([
      config.WEB_ORIGIN,
      "https://updatexsoftv.vercel.app",
      "http://127.0.0.1:3000",
      "http://localhost:3000",
    ]);
    const origin = req.header("Origin");
    if (mutation && !agentWithoutOrigin && origin && !allowed.has(origin)) {
      next(new ApiFailure(403, "ORIGIN_REJECTED", "Request origin is not allowed."));
      return;
    }
    next();
  });

  const auth = authRoutes(db);
  const base = "/api/v1";
  app.get(`${base}/health`, (_req, res) => { res.json({ status: "ok" }); });
  app.post(`${base}/license/activate`, (req, res, next) => {
    const key = `${req.ip ?? "local"}:license-activate`;
    const now = Date.now();
    const previous = attempts.get(key);
    const current = !previous || previous.reset < now ? { count: 0, reset: now + 5 * 60_000 } : previous;
    current.count += 1;
    attempts.set(key, current);
    if (current.count > 10) return next(new ApiFailure(429, "RATE_LIMITED", "Too many activation attempts. Try again later."));
    activateLocalLicense(req, res, next);
  });
  app.get(`${base}/ready`, asyncRoute(async (_req, res) => {
    await db.$queryRaw`SELECT 1`;
    // SELECT 1 alone can succeed even when a packaged API expects columns from
    // migrations that have not been applied. Check the schema used by Welcome.
    await db.user.count({ where: { accountEnabled: true } });
    await db.session.count({ where: { mode: "guest" } });
    res.json({ status: "ready", license: "offline_key_verified_v1",
      database: process.env.UPDATE_X_DB_PROVIDER === "sqlite" ? "sqlite" : "postgresql" });
  }));
  app.get(`${base}/auth/state`, auth.state);

  const limited = (route: string): express.RequestHandler => (req, _res, next) => {
    const key = `${req.ip ?? "local"}:${route}`;
    const now = Date.now();
    const entry = attempts.get(key);
    const current = !entry || entry.reset < now ? { count: 0, reset: now + 5 * 60_000 } : entry;
    current.count += 1;
    attempts.set(key, current);
    if (current.count > 10) return next(new ApiFailure(429, "RATE_LIMITED", "Too many attempts. Try again later."));
    next();
  };
  app.post(`${base}/auth/bootstrap`, limited("bootstrap"), auth.bootstrap);
  app.post(`${base}/auth/register`, limited("register"), auth.register);
  app.post(`${base}/auth/guest`, limited("guest"), auth.guest);
  app.post(`${base}/auth/session`, limited("login"), auth.login);
  app.delete(`${base}/auth/session`, auth.requireOwner, auth.requireCsrf, auth.logout);
  app.get(`${base}/agent/download`, (_req, res) => {
    const candidatePaths = [
      path.resolve(process.cwd(), "agent-release/UpdateX.Agent.exe"),
      path.resolve(process.cwd(), "../../agent-release/UpdateX.Agent.exe"),
      path.resolve(__dirname, "../../../agent-release/UpdateX.Agent.exe"),
      path.resolve(__dirname, "../../web/public/downloads/UpdateX.Agent.exe"),
    ];
    for (const exePath of candidatePaths) {
      if (fs.existsSync(exePath)) {
        res.setHeader("Content-Disposition", 'attachment; filename="UpdateX.Agent.exe"');
        res.setHeader("Content-Type", "application/vnd.microsoft.portable-executable");
        res.sendFile(exePath);
        return;
      }
    }
    res.status(404).json({ error: "AGENT_BINARY_NOT_FOUND", message: "Windows agent binary is not available yet." });
  });
  app.post(`${base}/agent/pairing/start`, limited("agent-pair"));
  app.use(`${base}/agent`, agentRoutes(db));
  app.use(base, auth.requireOwner, (req, res, next) => {
    if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method)) return auth.requireCsrf(req, res, next);
    next();
  }, ownerAgentRoutes(db), ownerUpdateRoutes(db), dataRoutes(db));
  app.use((_req, _res, next) => next(new ApiFailure(404, "NOT_FOUND", "This endpoint does not exist.")));
  app.use(errorHandler);
  return app;
}
