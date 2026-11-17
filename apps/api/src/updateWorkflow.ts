import { Router } from "express";
import type { Prisma, PrismaClient } from "@updatepilot/db";
import {
  UpdateExecuteSchema, UpdateResultSchema, UpdateProgressSchema,
  type DownloadDto, type UpdateJobDto, type UpdatePreviewDto,
} from "@updatepilot/contracts";
import { ownerId } from "./auth";
import { sha256 } from "./agentSecurity";
import { ApiFailure, asyncRoute } from "./errors";

const PREVIEW_MS = 5 * 60_000;
const UPDATE_LEASE_MS = 30 * 60_000;
const QUEUE_WAIT_MS = 15 * 60_000;
const ACTIVE = ["queued", "leased", "running", "verifying"];

export async function reconcileUpdateJobs(db: PrismaClient, scope: Prisma.UpdateJobWhereInput) {
  const staleQueued = await db.updateJob.findMany({ where: { ...scope, status: "queued",
    createdAt: { lte: new Date(Date.now() - QUEUE_WAIT_MS) } },
    select: { id: true, deviceId: true, packageId: true, requestedBy: true } });
  for (const job of staleQueued) {
    const changed = await db.updateJob.updateMany({ where: { id: job.id, status: "queued",
      createdAt: { lte: new Date(Date.now() - QUEUE_WAIT_MS) } }, data: { status: "expired",
      completedAt: new Date(), diagnosticCode: "QUEUE_WAIT_EXPIRED" } });
    if (changed.count !== 1) continue;
    await db.updateEvent.create({ data: { jobId: job.id, status: "expired", detail: "No update-enabled agent claimed the job within 15 minutes." } });
    await db.auditEvent.create({ data: { userId: job.requestedBy, deviceId: job.deviceId,
      kind: "update", action: "update.expired", status: "expired", target: job.id,
      detail: `${job.packageId}: QUEUE_WAIT_EXPIRED` } });
  }
  const expired = await db.updateJob.findMany({ where: { ...scope,
    status: { in: ["leased", "running", "verifying"] }, leaseUntil: { lte: new Date() } },
    select: { id: true, deviceId: true, packageId: true, requestedBy: true, status: true } });
  for (const job of expired) {
    const changed = await db.updateJob.updateMany({ where: { id: job.id, status: job.status,
      leaseUntil: { lte: new Date() } }, data: { status: "execution_unknown", completedAt: new Date(),
      leaseUntil: null, diagnosticCode: "AGENT_DISCONNECTED" } });
    if (changed.count !== 1) continue;
    await db.updateEvent.create({ data: { jobId: job.id, status: "execution_unknown",
      detail: "Agent did not report a result before its lease expired." } });
    await db.auditEvent.create({ data: { userId: job.requestedBy, deviceId: job.deviceId,
      kind: "update", action: "update.execution_unknown", status: "execution_unknown",
      target: job.id, detail: `${job.packageId}: AGENT_DISCONNECTED` } });
  }
}

type EligibleApp = Prisma.ApplicationGetPayload<{ include: { snapshot: { include: { device: true } } } }>;
type UpdateRecord = Prisma.UpdateJobGetPayload<Record<string, never>>;

function online(lastHeartbeatAt: Date | null): boolean {
  return lastHeartbeatAt !== null && Date.now() - lastHeartbeatAt.getTime() < 60_000;
}

function evidence(app: EligibleApp): string {
  return sha256(JSON.stringify([
    app.id, app.snapshotId, app.stableKey, app.snapshot.deviceId, app.packageId, app.source,
    app.publisher, app.installedVersion, app.availableVersion, app.matchStatus, app.updateStatus,
  ]));
}

function jobDto(job: UpdateRecord): UpdateJobDto {
  return {
    id: job.id, deviceId: job.deviceId, applicationId: job.applicationId,
    status: job.status as UpdateJobDto["status"], packageId: job.packageId, source: job.source,
    installedVersion: job.installedVersion, targetVersion: job.targetVersion,
    observedVersion: job.observedVersion, exitCode: job.exitCode, diagnosticCode: job.diagnosticCode,
    createdAt: job.createdAt.toISOString(), startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    progressStage: job.progressStage as UpdateJobDto["progressStage"],
    downloadPercent: job.downloadPercent,
    downloadedBytes: job.downloadedBytes === null ? null : Number(job.downloadedBytes),
    totalBytes: job.totalBytes === null ? null : Number(job.totalBytes),
    progressAt: job.progressAt?.toISOString() ?? null,
  };
}

async function eligible(db: PrismaClient, userId: string, appId: string): Promise<EligibleApp> {
  const app = await db.application.findFirst({ where: {
    id: appId, snapshot: { device: { ownerId: userId, revokedAt: null } },
  }, include: { snapshot: { include: { device: true } } } });
  if (!app) throw new ApiFailure(404, "APPLICATION_NOT_FOUND", "Application not found.");
  const latest = await db.scanSnapshot.findFirst({ where: { deviceId: app.snapshot.deviceId },
    orderBy: [{ takenAt: "desc" }, { id: "desc" }], select: { id: true } });
  if (latest?.id !== app.snapshotId) {
    throw new ApiFailure(409, "SCAN_STALE", "A newer scan exists. Review the current application result.");
  }
  const settings = await db.settings.findUnique({ where: { userId }, select: { scanReminderDays: true } });
  const maximumAge = (settings?.scanReminderDays ?? 7) * 24 * 60 * 60_000;
  if (Date.now() - app.snapshot.takenAt.getTime() > maximumAge)
    throw new ApiFailure(409, "SCAN_STALE", "This saved scan is old. Run a fresh scan before reviewing an update.");
  const executedSinceScan = await db.updateJob.findFirst({ where: {
    deviceId: app.snapshot.deviceId, packageId: app.packageId ?? "",
    executionStartedAt: { gt: app.snapshot.takenAt },
  }, select: { id: true } });
  if (executedSinceScan)
    throw new ApiFailure(409, "RESCAN_REQUIRED", "An update ran after this inventory snapshot. Wait for a fresh scan before reviewing it again.");
  if (app.matchStatus !== "verified" || app.updateStatus !== "available" ||
      app.source !== "winget" || !app.packageId || !app.publisher ||
      !app.installedVersion || !app.availableVersion ||
      app.installedVersion === app.availableVersion) {
    throw new ApiFailure(409, "UPDATE_NOT_ELIGIBLE", "This package has no verified update eligible for execution.");
  }
  if (!online(app.snapshot.device.lastHeartbeatAt)) {
    throw new ApiFailure(409, "AGENT_OFFLINE", "Start the paired Windows agent and refresh this view.");
  }
  return app;
}

function previewDto(preview: {
  id: string; applicationId: string; deviceId: string; packageId: string; source: string;
  publisher: string | null; installedVersion: string; targetVersion: string; expiresAt: Date;
}): UpdatePreviewDto {
  return {
    id: preview.id, applicationId: preview.applicationId, deviceId: preview.deviceId,
    packageId: preview.packageId, source: "winget", publisher: preview.publisher ?? "Unknown",
    installedVersion: preview.installedVersion, targetVersion: preview.targetVersion,
    expiresAt: preview.expiresAt.toISOString(),
    warnings: [
      "The installer may close the application or require a restart.",
      "WinGet may require an interactive agreement or Windows permission; UpdateX will stop instead of accepting it automatically.",
      "Success is recorded only after the installed version is checked again.",
    ],
  };
}

export function ownerUpdateRoutes(db: PrismaClient) {
  const router = Router();
  router.post("/applications/:id/preview", asyncRoute(async (req, res) => {
    const userId = ownerId(res);
    const app = await eligible(db, userId, String(req.params.id));
    const preview = await db.updatePreview.create({ data: {
      ownerId: userId, deviceId: app.snapshot.deviceId, applicationId: app.id,
      packageId: app.packageId!, source: "winget", publisher: app.publisher,
      installedVersion: app.installedVersion!, targetVersion: app.availableVersion!,
      evidenceHash: evidence(app), expiresAt: new Date(Date.now() + PREVIEW_MS),
    } });
    res.status(201).json(previewDto(preview));
  }));

  router.post("/updates/execute", asyncRoute(async (req, res) => {
    const userId = ownerId(res);
    const input = UpdateExecuteSchema.parse(req.body);
    const existing = await db.updateJob.findUnique({ where: {
      requestedBy_idempotencyKey: { requestedBy: userId, idempotencyKey: input.idempotencyKey },
    } });
    if (existing) {
      if (existing.previewId !== input.previewId)
        throw new ApiFailure(409, "IDEMPOTENCY_CONFLICT", "This request key belongs to another update.");
      res.status(202).json(jobDto(existing)); return;
    }
    const preview = await db.updatePreview.findFirst({ where: {
      id: input.previewId, ownerId: userId, consumedAt: null, expiresAt: { gt: new Date() },
    } });
    if (!preview) throw new ApiFailure(409, "PREVIEW_EXPIRED", "Review this update again before confirming.");
    const app = await eligible(db, userId, preview.applicationId);
    if (app.snapshot.device.executionMode !== "update_enabled")
      throw new ApiFailure(409, "AGENT_READ_ONLY", "The paired agent is read-only. No update job was created.");
    if (preview.evidenceHash !== evidence(app) || preview.deviceId !== app.snapshot.deviceId ||
        preview.packageId !== app.packageId || preview.installedVersion !== app.installedVersion ||
        preview.targetVersion !== app.availableVersion) {
      throw new ApiFailure(409, "PREVIEW_STALE", "Package evidence changed. Review this update again.");
    }
    let job: UpdateRecord;
    try {
      job = await db.$transaction(async tx => {
        const active = await tx.updateJob.count({ where: { deviceId: preview.deviceId, status: { in: ACTIVE } } });
        if (active) throw new ApiFailure(409, "UPDATE_ALREADY_ACTIVE", "Wait for the current update to finish.");
        const consumed = await tx.updatePreview.updateMany({ where: {
          id: preview.id, consumedAt: null, expiresAt: { gt: new Date() },
        }, data: { consumedAt: new Date() } });
        if (consumed.count !== 1) throw new ApiFailure(409, "PREVIEW_CONSUMED", "Review this update again.");
        const created = await tx.updateJob.create({ data: {
          deviceId: preview.deviceId, applicationId: app.id, requestedBy: userId,
          packageId: preview.packageId, source: "winget", publisher: preview.publisher,
          installedVersion: preview.installedVersion, targetVersion: preview.targetVersion,
          evidenceHash: preview.evidenceHash, previewId: preview.id,
          idempotencyKey: input.idempotencyKey,
        } });
        await tx.updateEvent.create({ data: { jobId: created.id, status: "queued", detail: "Owner confirmed exact package and version." } });
        await tx.auditEvent.create({ data: { userId, deviceId: preview.deviceId, kind: "update",
          action: "update.queued", status: "queued", target: created.id,
          detail: `${preview.packageId}: ${preview.installedVersion} → ${preview.targetVersion}` } });
        return created;
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
        const duplicate = await db.updateJob.findUnique({ where: {
          requestedBy_idempotencyKey: { requestedBy: userId, idempotencyKey: input.idempotencyKey },
        } });
        if (duplicate && duplicate.previewId === input.previewId) { res.status(202).json(jobDto(duplicate)); return; }
      }
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2034")
        throw new ApiFailure(409, "UPDATE_CONFLICT", "Another update changed. Review and retry.");
      throw error;
    }
    res.status(202).json(jobDto(job));
  }));

  router.get("/jobs", asyncRoute(async (req, res) => {
    const userId = ownerId(res);
    const deviceId = typeof req.query.deviceId === "string" && req.query.deviceId ? req.query.deviceId : undefined;
    await reconcileUpdateJobs(db, { requestedBy: userId, ...(deviceId ? { deviceId } : {}) });
    const where: Prisma.UpdateJobWhereInput = { requestedBy: userId, ...(deviceId ? { deviceId } : {}) };
    const jobs = await db.updateJob.findMany({ where,
      orderBy: { createdAt: "desc" }, take: 10 });
    res.json({ items: jobs.map(jobDto) });
  }));

  router.get("/downloads", asyncRoute(async (req, res) => {
    const userId = ownerId(res);
    const deviceId = typeof req.query.deviceId === "string" && req.query.deviceId ? req.query.deviceId : undefined;
    await reconcileUpdateJobs(db, { requestedBy: userId, ...(deviceId ? { deviceId } : {}) });
    const page = Math.min(100000, Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1));
    const pageSize = 20;
    const where: Prisma.UpdateJobWhereInput = { requestedBy: userId, ...(deviceId ? { deviceId } : {}) };
    const [total, jobs] = await Promise.all([
      db.updateJob.count({ where }),
      db.updateJob.findMany({ where,
        include: { application: { select: { displayName: true, publisher: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    const items: DownloadDto[] = jobs.map(job => ({ ...jobDto(job),
      applicationName: job.application.displayName, publisher: job.application.publisher }));
    res.json({ items, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
  }));

  router.get("/jobs/:id", asyncRoute(async (req, res) => {
    await reconcileUpdateJobs(db, { requestedBy: ownerId(res) });
    const job = await db.updateJob.findFirst({ where: { id: req.params.id, requestedBy: ownerId(res) },
      include: { events: { orderBy: { createdAt: "asc" } } } });
    if (!job) throw new ApiFailure(404, "JOB_NOT_FOUND", "Update job not found.");
    res.json({ ...jobDto(job), events: job.events.map(event => ({
      id: event.id, status: event.status, detail: event.detail, createdAt: event.createdAt.toISOString(),
      downloadPercent: event.downloadPercent,
      downloadedBytes: event.downloadedBytes === null ? null : Number(event.downloadedBytes),
      totalBytes: event.totalBytes === null ? null : Number(event.totalBytes),
    })) });
  }));
  router.post("/jobs/:id/cancel", asyncRoute(async (req, res) => {
    const userId = ownerId(res);
    const updated = await db.$transaction(async tx => {
      const job = await tx.updateJob.findFirst({ where: { id: req.params.id, requestedBy: userId } });
      if (!job) throw new ApiFailure(404, "JOB_NOT_FOUND", "Update job not found.");
      const changed = await tx.updateJob.updateMany({ where: { id: job.id, requestedBy: userId, status: "queued" },
        data: { status: "cancelled", completedAt: new Date(), diagnosticCode: "OWNER_CANCELLED" } });
      if (changed.count !== 1) throw new ApiFailure(409, "JOB_ALREADY_CLAIMED", "The agent already claimed this job; it cannot be cancelled safely.");
      await tx.updateEvent.create({ data: { jobId: job.id, status: "cancelled", detail: "Owner cancelled before agent claim." } });
      await tx.auditEvent.create({ data: { userId, deviceId: job.deviceId, kind: "update",
        action: "update.cancelled", status: "cancelled", target: job.id, detail: `${job.packageId}: OWNER_CANCELLED` } });
      return tx.updateJob.findUniqueOrThrow({ where: { id: job.id } });
    });
    res.json(jobDto(updated));
  }));
  return router;
}

export function agentUpdateRoutes(db: PrismaClient) {
  const router = Router();
  router.post("/updates/:id/claim", asyncRoute(async (req, res) => {
    const deviceId = String(res.locals.deviceId);
    const device = await db.device.findUnique({ where: { id: deviceId }, select: { executionMode: true } });
    if (device?.executionMode !== "update_enabled")
      throw new ApiFailure(409, "AGENT_READ_ONLY", "Update execution is not enabled for this agent session.");
    const now = new Date();
    const claimed = await db.updateJob.updateMany({ where: { id: req.params.id, deviceId, status: "queued",
      device: { revokedAt: null, executionMode: "update_enabled" } },
      data: { status: "leased", startedAt: now, leaseUntil: new Date(now.getTime() + UPDATE_LEASE_MS) } });
    if (claimed.count !== 1) throw new ApiFailure(409, "UPDATE_NOT_QUEUED", "Update job is no longer available.");
    const job = await db.updateJob.findUniqueOrThrow({ where: { id: req.params.id },
      include: { application: { select: { stableKey: true } } } });
    await db.updateEvent.create({ data: { jobId: job.id, status: "leased", detail: "Paired agent claimed the job." } });
    res.json({ ...jobDto(job), stableKey: job.application.stableKey,
      publisher: job.publisher, evidenceHash: job.evidenceHash,
      leaseUntil: job.leaseUntil?.toISOString() ?? null });
  }));

  router.post("/updates/:id/renew", asyncRoute(async (req, res) => {
    const deviceId = String(res.locals.deviceId);
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + UPDATE_LEASE_MS);
    const changed = await db.updateJob.updateMany({ where: { id: req.params.id, deviceId,
      status: { in: ["leased", "running", "verifying"] }, leaseUntil: { gt: now } },
    data: { leaseUntil } });
    if (changed.count !== 1) throw new ApiFailure(409, "UPDATE_LEASE_INVALID", "Update lease is invalid or expired.");
    res.json({ leaseUntil: leaseUntil.toISOString() });
  }));

  router.post("/updates/:id/started", asyncRoute(async (req, res) => {
    const deviceId = String(res.locals.deviceId);
    const now = new Date();
    const updated = await db.updateJob.updateMany({ where: { id: req.params.id, deviceId,
      status: "leased", leaseUntil: { gt: now } },
    data: { status: "running", executionStartedAt: now } });
    if (updated.count !== 1) throw new ApiFailure(409, "UPDATE_LEASE_INVALID", "Update lease is invalid or expired.");
    await db.updateEvent.create({ data: { jobId: String(req.params.id), status: "running", detail: "WinGet execution was authorized." } });
    res.json({ status: "running" });
  }));

  router.post("/updates/:id/verifying", asyncRoute(async (req, res) => {
    const deviceId = String(res.locals.deviceId);
    const now = new Date();
    const changed = await db.updateJob.updateMany({ where: { id: req.params.id, deviceId,
      status: "running", leaseUntil: { gt: now }, executionStartedAt: { not: null } },
    data: { status: "verifying", progressStage: null, downloadPercent: null,
      downloadedBytes: null, totalBytes: null, progressAt: now } });
    if (changed.count !== 1) throw new ApiFailure(409, "UPDATE_LEASE_INVALID", "Update lease is invalid or expired.");
    await db.updateEvent.create({ data: { jobId: String(req.params.id), status: "verifying",
      detail: "WinGet exited successfully; checking the installed version." } });
    res.json({ status: "verifying" });
  }));

  router.post("/updates/:id/progress", asyncRoute(async (req, res) => {
    const deviceId = String(res.locals.deviceId);
    const input = UpdateProgressSchema.parse(req.body);
    const now = new Date();
    const changed = await db.updateJob.updateMany({ where: { id: req.params.id, deviceId,
      status: "running", leaseUntil: { gt: now }, executionStartedAt: { not: null } },
      data: { progressStage: input.stage, downloadPercent: input.percent,
        downloadedBytes: input.downloadedBytes === null ? null : BigInt(input.downloadedBytes),
        totalBytes: input.totalBytes === null ? null : BigInt(input.totalBytes), progressAt: now } });
    if (changed.count !== 1) throw new ApiFailure(409, "UPDATE_LEASE_INVALID", "Progress rejected: update is not running under a valid lease.");
    await db.updateEvent.create({ data: { jobId: String(req.params.id), status: input.stage,
      detail: input.stage === "installing" ? "WinGet reports installer execution." : "WinGet reports download progress.",
      downloadPercent: input.percent,
      downloadedBytes: input.downloadedBytes === null ? null : BigInt(input.downloadedBytes),
      totalBytes: input.totalBytes === null ? null : BigInt(input.totalBytes) } });
    res.json({ accepted: true });
  }));

  router.post("/updates/:id/result", asyncRoute(async (req, res) => {
    const deviceId = String(res.locals.deviceId);
    const input = UpdateResultSchema.parse(req.body);
    const now = new Date();
    const job = await db.updateJob.findFirst({ where: { id: req.params.id, deviceId,
      status: { in: ["leased", "running", "verifying"] } } });
    if (!job || !job.leaseUntil || job.leaseUntil <= now)
      throw new ApiFailure(409, "UPDATE_LEASE_INVALID", "Update lease is invalid or expired.");
    if (input.executionStarted && !job.executionStartedAt)
      throw new ApiFailure(409, "UPDATE_NOT_STARTED", "Execution was not recorded before the result.");
    if (input.status === "succeeded" && input.observedVersion !== job.targetVersion)
      throw new ApiFailure(409, "VERSION_NOT_VERIFIED", "The observed version does not match the approved target.");
    if (input.status === "succeeded" && job.status !== "running" && job.status !== "verifying")
      throw new ApiFailure(409, "UPDATE_NOT_STARTED", "WinGet execution was not recorded.");
    if (job.status === "leased" && input.status !== "failed" && input.status !== "action_required")
      throw new ApiFailure(409, "UPDATE_NOT_STARTED", "Preflight can only fail or require action.");
    const updated = await db.$transaction(async tx => {
      const reserved = await tx.updateJob.updateMany({ where: { id: job.id, deviceId,
        status: job.status, leaseUntil: { gt: now } }, data: {
        status: input.status, observedVersion: input.observedVersion, exitCode: input.exitCode,
        diagnosticCode: input.diagnosticCode, completedAt: now, leaseUntil: null,
      } });
      if (reserved.count !== 1) throw new ApiFailure(409, "UPDATE_RESULT_CONFLICT", "Job result was already recorded.");
      await tx.updateEvent.create({ data: { jobId: job.id, status: input.status,
        detail: input.diagnosticCode ?? (input.status === "succeeded" ? `Verified ${input.observedVersion}` : null) } });
      await tx.auditEvent.create({ data: { userId: job.requestedBy, deviceId, kind: "update",
        action: `update.${input.status}`, status: input.status, target: job.id,
        detail: input.status === "succeeded"
          ? `${job.packageId} verified at ${input.observedVersion}`
          : `${job.packageId}: ${input.diagnosticCode ?? input.status}` } });
      if (input.executionStarted && await tx.scanJob.count({ where: { deviceId,
        OR: [{ status: "queued" }, { status: "running", leaseUntil: { gt: now } }] } }) === 0) {
        await tx.scanJob.create({ data: { deviceId, requestedBy: job.requestedBy } });
        await tx.auditEvent.create({ data: { userId: job.requestedBy, deviceId, kind: "scan",
          action: "scan.queued", status: "queued", target: job.id,
          detail: "Read-only inventory refresh queued after update attempt." } });
      }
      return tx.updateJob.findUniqueOrThrow({ where: { id: job.id } });
    });
    res.json(jobDto(updated));
  }));
  return router;
}
