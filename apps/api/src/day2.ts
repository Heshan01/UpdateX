import { Router } from "express";
import type { PrismaClient } from "@updatepilot/db";
import {
  AgentHeartbeatSchema, PairingApproveSchema, PairingCodeSchema, PairingStartSchema, ScanResultSchema,
  type AgentActivityDto, type ScanJobDto,
} from "@updatepilot/contracts";
import { ownerId } from "./auth";
import { agentAuth, keyFingerprint, newPairingCode, sha256, verifyPairingPoll } from "./agentSecurity";
import { ApiFailure, asyncRoute } from "./errors";
import { deviceDto } from "./data";
import { agentUpdateRoutes, reconcileUpdateJobs } from "./updateWorkflow";

const PAIRING_MS = 10 * 60_000;
const SCAN_LEASE_MS = 5 * 60_000;
const SCAN_QUEUE_WAIT_MS = 15 * 60_000;

async function expireScanLease(db: PrismaClient, deviceId: string) {
  const staleQueued = await db.scanJob.findMany({ where: { deviceId, status: "queued",
    createdAt: { lte: new Date(Date.now() - SCAN_QUEUE_WAIT_MS) } },
    select: { id: true, requestedBy: true } });
  for (const job of staleQueued) {
    const changed = await db.scanJob.updateMany({ where: { id: job.id, status: "queued",
      createdAt: { lte: new Date(Date.now() - SCAN_QUEUE_WAIT_MS) } }, data: { status: "failed",
      completedAt: new Date(), errorCode: "SCAN_QUEUE_EXPIRED" } });
    if (changed.count === 1) await db.auditEvent.create({ data: { userId: job.requestedBy, deviceId,
      kind: "scan", action: "scan.failed", status: "failed", detail: "SCAN_QUEUE_EXPIRED" } });
  }
  const expired = await db.scanJob.findMany({ where: { deviceId, status: "running",
    leaseUntil: { lte: new Date() } }, select: { id: true, requestedBy: true } });
  for (const job of expired) {
    const changed = await db.scanJob.updateMany({ where: { id: job.id, status: "running",
      leaseUntil: { lte: new Date() } }, data: { status: "failed", completedAt: new Date(),
      leaseUntil: null, errorCode: "AGENT_DISCONNECTED" } });
    if (changed.count === 1) await db.auditEvent.create({ data: { userId: job.requestedBy, deviceId,
      kind: "scan", action: "scan.failed", status: "failed", detail: "AGENT_DISCONNECTED" } });
  }
}

function scanDto(job: {
  id: string; deviceId: string; status: string; createdAt: Date;
  startedAt: Date | null; completedAt: Date | null; errorCode: string | null;
}): ScanJobDto {
  return { id: job.id, deviceId: job.deviceId, status: job.status as ScanJobDto["status"],
    createdAt: job.createdAt.toISOString(), startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null, errorCode: job.errorCode };
}

function isUnique(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

export function ownerAgentRoutes(db: PrismaClient) {
  const router = Router();

  router.get("/devices/:id/activity", asyncRoute(async (req, res) => {
    const device = await db.device.findFirst({ where: { id: req.params.id, ownerId: ownerId(res), revokedAt: null } });
    if (!device) throw new ApiFailure(404, "DEVICE_NOT_FOUND", "Paired device not found.");
    await Promise.all([expireScanLease(db, device.id), reconcileUpdateJobs(db, { deviceId: device.id })]);
    const [activeScans, activeUpdates] = await Promise.all([
      db.scanJob.count({ where: { deviceId: device.id, status: { in: ["queued", "running"] } } }),
      db.updateJob.count({ where: { deviceId: device.id, status: { in: ["queued", "leased", "running", "verifying"] } } }),
    ]);
    const activity: AgentActivityDto = { device: deviceDto(device), activeScans, activeUpdates };
    res.json(activity);
  }));

  router.post("/devices/pairing/lookup", asyncRoute(async (req, res) => {
    const { code } = PairingCodeSchema.parse(req.body);
    const pairing = await db.pairingRequest.findUnique({ where: { codeHash: sha256(code) } });
    if (!pairing || pairing.expiresAt <= new Date() || pairing.approvedAt) {
      throw new ApiFailure(404, "PAIRING_NOT_FOUND", "Pairing code is invalid or expired.");
    }
    res.json({ deviceName: pairing.deviceName, agentVersion: pairing.agentVersion,
      osVersion: pairing.osVersion, fingerprint: pairing.keyFingerprint, expiresAt: pairing.expiresAt.toISOString() });
  }));

  router.post("/devices/pair", asyncRoute(async (req, res) => {
    const { code, fingerprint } = PairingApproveSchema.parse(req.body);
    const userId = ownerId(res);
    const pairing = await db.pairingRequest.findUnique({ where: { codeHash: sha256(code) } });
    if (!pairing || pairing.expiresAt <= new Date() || pairing.approvedAt) {
      throw new ApiFailure(404, "PAIRING_NOT_FOUND", "Pairing code is invalid or expired.");
    }
    if (pairing.keyFingerprint !== fingerprint) {
      throw new ApiFailure(409, "FINGERPRINT_CHANGED", "Agent identity does not match the reviewed key.");
    }
    const result = await db.$transaction(async tx => {
      const reserved = await tx.pairingRequest.updateMany({ where: { id: pairing.id, approvedAt: null, expiresAt: { gt: new Date() } },
        data: { approvedAt: new Date(), ownerId: userId } });
      if (reserved.count !== 1) throw new ApiFailure(409, "PAIRING_CONSUMED", "This code has already been used.");
      const device = await tx.device.create({ data: { ownerId: userId, name: pairing.deviceName,
        agentVersion: pairing.agentVersion, osVersion: pairing.osVersion,
        publicKeyPem: pairing.publicKeyPem, keyFingerprint: pairing.keyFingerprint } });
      await tx.pairingRequest.update({ where: { id: pairing.id }, data: { deviceId: device.id } });
      const scan = await tx.scanJob.create({ data: { deviceId: device.id, requestedBy: userId } });
      await tx.auditEvent.create({ data: { userId, deviceId: device.id, action: "agent.paired",
        detail: `Paired ${device.name}; first scan queued` } });
      return { device, scan };
    }).catch(error => {
      if (isUnique(error)) throw new ApiFailure(409, "AGENT_KEY_EXISTS", "This agent key was already paired.");
      throw error;
    });
    res.status(201).json({ deviceId: result.device.id, scan: scanDto(result.scan) });
  }));

  router.post("/devices/:id/revoke", asyncRoute(async (req, res) => {
    const userId = ownerId(res);
    const device = await db.device.findFirst({ where: { id: req.params.id, ownerId: userId, revokedAt: null } });
    if (!device) throw new ApiFailure(404, "DEVICE_NOT_FOUND", "Device not found.");
    const now = new Date();
    await db.$transaction(async tx => {
      await tx.device.update({ where: { id: device.id }, data: { revokedAt: now, lastSeenAt: null } });
      await tx.scanJob.updateMany({ where: { deviceId: device.id, status: { in: ["queued", "running"] } },
        data: { status: "cancelled", completedAt: now, errorCode: "AGENT_REVOKED" } });
      await tx.updateJob.updateMany({ where: { deviceId: device.id, status: "queued" },
        data: { status: "cancelled", completedAt: now, diagnosticCode: "AGENT_REVOKED" } });
      await tx.updateJob.updateMany({ where: { deviceId: device.id, status: { in: ["leased", "running", "verifying"] } },
        data: { status: "execution_unknown", completedAt: now, diagnosticCode: "AGENT_REVOKED" } });
      await tx.auditEvent.create({ data: { userId, deviceId: device.id, action: "agent.revoked", status: "info",
        detail: `Revoked ${device.name}` } });
    });
    res.status(204).end();
  }));

  router.post("/devices/:id/rotate-key", asyncRoute(async (req, res) => {
    const userId = ownerId(res);
    const { code, fingerprint } = PairingApproveSchema.parse(req.body);
    const device = await db.device.findFirst({ where: { id: req.params.id, ownerId: userId, revokedAt: null } });
    if (!device) throw new ApiFailure(404, "DEVICE_NOT_FOUND", "Device not found.");
    if (device.lastHeartbeatAt && Date.now() - device.lastHeartbeatAt.getTime() < 60_000)
      throw new ApiFailure(409, "AGENT_STILL_ONLINE", "Stop the old agent and wait until it shows offline before rotating its key.");
    const pairing = await db.pairingRequest.findUnique({ where: { codeHash: sha256(code) } });
    if (!pairing || pairing.expiresAt <= new Date() || pairing.approvedAt)
      throw new ApiFailure(404, "PAIRING_NOT_FOUND", "New key code is invalid or expired.");
    if (pairing.keyFingerprint !== fingerprint)
      throw new ApiFailure(409, "FINGERPRINT_CHANGED", "The new key does not match the reviewed fingerprint.");
    if (pairing.deviceName !== device.name)
      throw new ApiFailure(409, "DEVICE_NAME_MISMATCH", "The new key reports a different Windows computer name.");
    try {
      await db.$transaction(async tx => {
        const activeUpdates = await tx.updateJob.count({ where: { deviceId: device.id,
          status: { in: ["queued", "leased", "running", "verifying"] } } });
        const runningScans = await tx.scanJob.count({ where: { deviceId: device.id, status: "running" } });
        if (activeUpdates || runningScans)
          throw new ApiFailure(409, "DEVICE_BUSY", "Wait for active jobs to settle before rotating this key.");
        const reserved = await tx.pairingRequest.updateMany({ where: { id: pairing.id, approvedAt: null,
          expiresAt: { gt: new Date() } }, data: { approvedAt: new Date(), ownerId: userId, deviceId: device.id } });
        if (reserved.count !== 1) throw new ApiFailure(409, "PAIRING_CONSUMED", "This key code was already used.");
        const changed = await tx.device.updateMany({ where: { id: device.id, ownerId: userId,
          revokedAt: null, keyFingerprint: device.keyFingerprint }, data: {
          publicKeyPem: pairing.publicKeyPem, keyFingerprint: pairing.keyFingerprint,
          agentVersion: pairing.agentVersion, osVersion: pairing.osVersion,
          lastSeenAt: null, lastHeartbeatAt: null, executionMode: "read_only",
        } });
        if (changed.count !== 1) throw new ApiFailure(409, "DEVICE_CHANGED", "The device changed. Review the new key again.");
        await tx.auditEvent.create({ data: { userId, deviceId: device.id, action: "agent.key_rotated",
          detail: "Owner approved a new agent key; previous key invalidated." } });
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if (isUnique(error)) throw new ApiFailure(409, "AGENT_KEY_EXISTS", "This key is already paired elsewhere.");
      throw error;
    }
    res.json({ deviceId: device.id, fingerprint: pairing.keyFingerprint });
  }));

  router.post("/devices/:id/scans", asyncRoute(async (req, res) => {
    const userId = ownerId(res);
    const device = await db.device.findFirst({ where: { id: req.params.id, ownerId: userId, revokedAt: null } });
    if (!device) throw new ApiFailure(404, "DEVICE_NOT_FOUND", "Device not found.");
    await expireScanLease(db, device.id);
    const active = await db.scanJob.findFirst({ where: { deviceId: device.id, status: { in: ["queued", "running"] } } });
    if (active) { res.status(202).json(scanDto(active)); return; }
    const scan = await db.scanJob.create({ data: { deviceId: device.id, requestedBy: userId } });
    await db.auditEvent.create({ data: { userId, deviceId: device.id, kind: "scan", action: "scan.queued", status: "queued",
      detail: `Scan queued for ${device.name}` } });
    res.status(202).json(scanDto(scan));
  }));

  router.get("/devices/:id/scans/latest", asyncRoute(async (req, res) => {
    const device = await db.device.findFirst({ where: {
      id: req.params.id, ownerId: ownerId(res), revokedAt: null,
    }, select: { id: true } });
    if (!device) throw new ApiFailure(404, "DEVICE_NOT_FOUND", "Device not found.");
    await expireScanLease(db, device.id);
    const scan = await db.scanJob.findFirst({ where: { deviceId: device.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    res.json(scan ? scanDto(scan) : null);
  }));

  router.get("/scans/:id", asyncRoute(async (req, res) => {
    const existing = await db.scanJob.findFirst({ where: { id: req.params.id, device: { ownerId: ownerId(res) } } });
    if (existing) await expireScanLease(db, existing.deviceId);
    const job = await db.scanJob.findFirst({ where: { id: req.params.id, device: { ownerId: ownerId(res) } } });
    if (!job) throw new ApiFailure(404, "SCAN_NOT_FOUND", "Scan job not found.");
    res.json(scanDto(job));
  }));
  return router;
}

export function agentRoutes(db: PrismaClient) {
  const router = Router();
  router.post("/pairing/start", asyncRoute(async (req, res) => {
    const input = PairingStartSchema.parse(req.body);
    const fingerprint = keyFingerprint(input.publicKeyPem);
    if (await db.device.findUnique({ where: { keyFingerprint: fingerprint } })) {
      throw new ApiFailure(409, "AGENT_KEY_EXISTS", "This key was paired before; use the existing identity or create a new key.");
    }
    const code = newPairingCode();
    const pairing = await db.pairingRequest.create({ data: {
      codeHash: sha256(code), publicKeyPem: input.publicKeyPem, keyFingerprint: fingerprint,
      deviceName: input.deviceName, agentVersion: input.agentVersion, osVersion: input.osVersion,
      expiresAt: new Date(Date.now() + PAIRING_MS),
    } });
    res.status(201).json({ pairingId: pairing.id, code, fingerprint, expiresAt: pairing.expiresAt.toISOString() });
  }));
  router.get("/pairing/:id", verifyPairingPoll(db), (req, res) => {
    const pairing = res.locals.pairing as { deviceId: string | null };
    res.json({ paired: !!pairing.deviceId, deviceId: pairing.deviceId });
  });

  router.use(agentAuth(db));
  router.post("/heartbeat", asyncRoute(async (req, res) => {
    const { executionMode } = AgentHeartbeatSchema.parse(req.body);
    await db.device.update({ where: { id: String(res.locals.deviceId) },
      data: { executionMode, lastHeartbeatAt: new Date() } });
    res.json({ status: "ok", serverTime: new Date().toISOString(), executionMode });
  }));
  router.get("/jobs/next", asyncRoute(async (_req, res) => {
    const deviceId = String(res.locals.deviceId);
    await expireScanLease(db, deviceId);
    await reconcileUpdateJobs(db, { deviceId });
    const scan = await db.scanJob.findFirst({ where: { deviceId, status: "queued" }, orderBy: { createdAt: "asc" } });
    if (scan) { res.json({ kind: "scan", jobId: scan.id }); return; }
    const device = await db.device.findUnique({ where: { id: deviceId }, select: { executionMode: true } });
    const update = device?.executionMode === "update_enabled"
      ? await db.updateJob.findFirst({ where: { deviceId, status: "queued" }, orderBy: { createdAt: "asc" } }) : null;
    if (update) { res.json({ kind: "update", jobId: update.id }); return; }
    res.json({ kind: "none" });
  }));
  router.post("/scans/:id/claim", asyncRoute(async (req, res) => {
    const deviceId = String(res.locals.deviceId);
    const now = new Date();
    const claimed = await db.scanJob.updateMany({ where: { id: req.params.id, deviceId, status: "queued" },
      data: { status: "running", startedAt: now, leaseUntil: new Date(now.getTime() + SCAN_LEASE_MS) } });
    if (claimed.count !== 1) throw new ApiFailure(409, "SCAN_NOT_QUEUED", "Scan is no longer available.");
    res.json({ jobId: req.params.id, leaseUntil: new Date(now.getTime() + SCAN_LEASE_MS).toISOString() });
  }));
  router.post("/scans/:id/renew", asyncRoute(async (req, res) => {
    const deviceId = String(res.locals.deviceId);
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + SCAN_LEASE_MS);
    const changed = await db.scanJob.updateMany({ where: { id: req.params.id, deviceId,
      status: "running", leaseUntil: { gt: now } }, data: { leaseUntil } });
    if (changed.count !== 1) throw new ApiFailure(409, "SCAN_LEASE_INVALID", "Scan lease is invalid or expired.");
    res.json({ leaseUntil: leaseUntil.toISOString() });
  }));
  router.post("/scans/:id/result", asyncRoute(async (req, res) => {
    const deviceId = String(res.locals.deviceId);
    const input = ScanResultSchema.parse(req.body);
    const now = new Date();
    const result = await db.$transaction(async tx => {
      const job = await tx.scanJob.findFirst({ where: { id: req.params.id, deviceId, status: "running" } });
      if (!job) throw new ApiFailure(409, "SCAN_NOT_RUNNING", "Scan is not running for this agent.");
      if (!job.leaseUntil || job.leaseUntil <= now) throw new ApiFailure(409, "SCAN_LEASE_EXPIRED", "Scan lease expired; start a new scan.");
      if (input.status === "succeeded") {
        const snapshot = await tx.scanSnapshot.create({ data: { deviceId, scanJobId: job.id,
          takenAt: now, rawObservationCount: input.rawObservationCount } });
        await tx.application.createMany({ data: input.applications.map(item => ({
            snapshotId: snapshot.id,
            stableKey: item.stableKey, displayName: item.displayName, publisher: item.publisher,
            installedVersion: item.installedVersion, packageId: item.packageId, source: item.source,
            availableVersion: item.availableVersion, matchStatus: item.matchStatus,
            updateStatus: item.updateStatus, matchReason: item.matchReason, evidenceType: item.evidenceType,
            installScope: item.installScope, architecture: item.architecture,
            installLocation: item.installLocation, installationType: item.installationType,
            observedAt: now,
          })) });
        const applications = await tx.application.findMany({ where: { snapshotId: snapshot.id },
          select: { id: true, stableKey: true } });
        const ids = new Map(applications.map(application => [application.stableKey, application.id]));
        await tx.applicationObservation.createMany({ data: input.applications.flatMap(item =>
          item.observations.map(observation => ({
            applicationId: ids.get(item.stableKey)!, sourceKey: observation.sourceKey,
            evidenceType: observation.evidenceType, displayName: observation.displayName,
            publisher: observation.publisher, installedVersion: observation.installedVersion,
            packageId: observation.packageId, registryHive: observation.registryHive,
            registryView: observation.registryView, registryKey: observation.registryKey,
            packageFamilyName: observation.packageFamilyName ?? null,
            installLocation: observation.installLocation, displayIcon: observation.displayIcon,
            architecture: observation.architecture, installScope: observation.installScope,
            windowsInstaller: observation.windowsInstaller,
          }))) });
      }
      const updated = await tx.scanJob.update({ where: { id: job.id }, data: {
        status: input.status, completedAt: now, leaseUntil: null, errorCode: input.errorCode,
      } });
      await tx.auditEvent.create({ data: { userId: job.requestedBy, deviceId, kind: "scan",
        action: input.status === "succeeded" ? "scan.succeeded" : "scan.failed", status: input.status,
        detail: input.status === "succeeded"
          ? `${input.rawObservationCount} raw observations resolved to ${input.applications.length} applications`
          : input.errorCode } });
      return updated;
    });
    res.json(scanDto(result));
  }));
  router.use(agentUpdateRoutes(db));
  return router;
}
