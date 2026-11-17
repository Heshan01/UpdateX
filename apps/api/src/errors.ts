import type { ErrorRequestHandler, RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { ZodError } from "@updatepilot/contracts";

export class ApiFailure extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const requestId: RequestHandler = (req, res, next) => {
  const id = randomUUID();
  res.locals.requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
};

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  const requestId = String(res.locals.requestId ?? "unknown");
  if (error instanceof ZodError) {
    res.status(400).json({ code: "VALIDATION_ERROR", message: "The request contains invalid fields.", requestId,
      details: error.issues.map(({ path, message }) => ({ field: path.join("."), message })) });
    return;
  }
  if (error instanceof ApiFailure) {
    res.status(error.status).json({ code: error.code, message: error.message, requestId });
    return;
  }
  const databaseCode = typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" ? error.code : null;
  if (databaseCode === "P2021" || databaseCode === "P2022") {
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), component: "updatex-api",
      event: "request_failed", requestId, code: "DATABASE_SCHEMA_OUTDATED" }));
    res.status(503).json({ code: "DATABASE_SCHEMA_OUTDATED",
      message: "The local database schema is older than this UpdateX build. Review and apply the pending Prisma migrations manually.", requestId });
    return;
  }
  if (databaseCode === "P1000" || databaseCode === "P1001" || databaseCode === "P1002" || databaseCode === "P1017") {
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), component: "updatex-api",
      event: "request_failed", requestId, code: "DATABASE_CONNECTION_FAILED" }));
    res.status(503).json({ code: "DATABASE_CONNECTION_FAILED",
      message: "UpdateX cannot use the configured local PostgreSQL connection. Check the selected database configuration and service.", requestId });
    return;
  }
  // Database and unexpected errors must not expose SQL, credentials or stack traces.
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), component: "updatex-api",
    event: "request_failed", requestId, code: "SERVICE_UNAVAILABLE",
    errorType: error instanceof Error ? error.name : "unknown" }));
  res.status(503).json({ code: "SERVICE_UNAVAILABLE", message: "The local service is unavailable. Check the API and database.", requestId });
};

export function asyncRoute(fn: RequestHandler): RequestHandler {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
