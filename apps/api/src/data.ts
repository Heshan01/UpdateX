import { Router } from "express";
import { matchesApplicationSearch, type Prisma, type PrismaClient } from "@updatepilot/db";
import type { ApplicationDetailDto, ApplicationDto, DashboardDto, DeviceDto, HistoryItemDto, JobStatus, UpdateHistoryDto } from "@updatepilot/contracts";
import { ApplicationQuerySchema, HistoryQuerySchema, SettingsPatchSchema } from "@updatepilot/contracts";
import { csv } from "./csv";
import { officialReleaseInfo } from "./releaseInfo";
import { ApiFailure, asyncRoute } from "./errors";
import { ownerId } from "./auth";

type DeviceRecord = {
  id: string; name: string; agentVersion: string | null; osVersion: string | null;
  lastSeenAt: Date | null; revokedAt: Date | null;
  lastHeartbeatAt?: Date | null; executionMode?: string;
};

export function deviceDto(device: DeviceRecord): DeviceDto {
  const online = device.lastHeartbeatAt != null && Date.now() - device.lastHeartbeatAt.getTime() < 60_000;
  return {
    id: device.id,
    name: device.name,
    agentVersion: device.agentVersion,
    osVersion: device.osVersion,
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    lastHeartbeatAt: device.lastHeartbeatAt?.toISOString() ?? null,
    executionMode: device.executionMode === "update_enabled" ? "update_enabled" : "read_only",
    revokedAt: device.revokedAt?.toISOString() ?? null,
    connection: device.revokedAt ? "revoked" : online ? "online" : "offline",
  };
}

type ApplicationRecord = {
  id: string; snapshot: { deviceId: string }; displayName: string; publisher: string | null;
  installedVersion: string | null; packageId: string | null; source: string | null;
  availableVersion: string | null; matchStatus: string; updateStatus: string;
  matchReason: string | null; observedAt: Date;
  installScope?: string | null; architecture?: string | null; installationType?: string;
  _count?: { observations: number };
};

function applicationDto(app: ApplicationRecord): ApplicationDto {
  return {
    id: app.id,
    deviceId: app.snapshot.deviceId,
    displayName: app.displayName,
    publisher: app.publisher,
    installedVersion: app.installedVersion,
    packageId: app.packageId,
    source: app.source,
    availableVersion: app.availableVersion,
    matchStatus: app.matchStatus as ApplicationDto["matchStatus"],
    updateStatus: app.updateStatus as ApplicationDto["updateStatus"],
    matchReason: app.matchReason,
    observedAt: app.observedAt.toISOString(),
    installScope: app.installScope ?? null,
    architecture: app.architecture ?? null,
    installationType: app.installationType ?? "unknown",
    observationCount: app._count?.observations ?? 0,
  };
}

function auditDto(event: { id: string; kind: string; action: string; detail: string | null; status: string; createdAt: Date }): HistoryItemDto {
  const titles: Record<string, string> = {
    "owner.created": "Owner account created",
    "owner.signed_in": "Signed in",
    "settings.theme_changed": "Theme changed",
  };
  return {
    id: event.id,
    kind: event.kind === "scan" || event.kind === "update" ? event.kind : "audit",
    title: titles[event.action] ?? event.action.replaceAll(".", " "),
    detail: event.detail,
    status: (event.status === "info" ? "info" : event.status) as JobStatus | "info",
    createdAt: event.createdAt.toISOString(),
  };
}

export function dataRoutes(db: PrismaClient) {
  const router = Router();

  router.get("/dashboard", asyncRoute(async (req, res) => {
    const userId = ownerId(res);
    const deviceId = typeof req.query.deviceId === "string" && req.query.deviceId ? req.query.deviceId : undefined;
    const device = deviceId
      ? await db.device.findFirst({ where: { id: deviceId, ownerId: userId, revokedAt: null } })
      : await db.device.findFirst({ where: { ownerId: userId, revokedAt: null }, orderBy: { createdAt: "desc" } });
    const snapshot = device ? await db.scanSnapshot.findFirst({ where: { deviceId: device.id }, orderBy: { takenAt: "desc" } }) : null;
    const [inventoryCount, updateCount, unsupportedCount, activity, settings] = await Promise.all([
      snapshot ? db.application.count({ where: { snapshotId: snapshot.id } }) : Promise.resolve(0),
      snapshot ? db.application.count({ where: { snapshotId: snapshot.id, updateStatus: "available" } }) : Promise.resolve(0),
      snapshot ? db.application.count({ where: { snapshotId: snapshot.id, matchStatus: { not: "verified" } } }) : Promise.resolve(0),
      db.auditEvent.findMany({ where: { userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 5 }),
      db.settings.findUnique({ where: { userId } }),
    ]);
    const result: DashboardDto = {
      inventoryCount, updateCount, unsupportedCount,
      lastScanAt: snapshot?.takenAt.toISOString() ?? null,
      agent: device ? deviceDto(device) : null,
      recentActivity: activity.map(auditDto),
      scanReminderDays: settings?.scanReminderDays ?? 7,
    };
    res.json(result);
  }));

  router.get("/devices", asyncRoute(async (_req, res) => {
    const devices = await db.device.findMany({ where: { ownerId: ownerId(res) }, orderBy: { createdAt: "desc" } });
    res.json({ items: devices.map(deviceDto) });
  }));

  router.get("/applications", asyncRoute(async (req, res) => {
    const q = ApplicationQuerySchema.parse(req.query);
    const userId = ownerId(res);
    const device = q.deviceId
      ? await db.device.findFirst({ where: { id: q.deviceId, ownerId: userId, revokedAt: null } })
      : await db.device.findFirst({ where: { ownerId: userId, revokedAt: null }, orderBy: { createdAt: "desc" } });
    const snapshot = device ? await db.scanSnapshot.findFirst({ where: { deviceId: device.id }, orderBy: { takenAt: "desc" } }) : null;
    if (!snapshot) {
      res.json({ items: [], page: q.page, pageSize: q.pageSize, total: 0, totalPages: 0 });
      return;
    }
    const where: Prisma.ApplicationWhereInput = {
      snapshotId: snapshot.id,
      ...(q.installationType ? { installationType: q.installationType } : {}),
      ...(q.match ? { matchStatus: q.match } : {}),
      ...(q.update ? { updateStatus: q.update } : {}),
    };
    const sortField = q.sort === "name" ? "displayName" : q.sort;
    const orderBy: Prisma.ApplicationOrderByWithRelationInput = { [sortField]: q.direction };
    const include = { snapshot: { select: { deviceId: true } },
      _count: { select: { observations: true } } } as const;
    const search = q.search;
    if (search) {
      // An inventory is local and bounded by a single scan. Filtering before
      // pagination preserves Unicode matching across PostgreSQL and SQLite.
      const candidates = await db.application.findMany({ where, include,
        orderBy: [orderBy, { id: "asc" }] });
      const matched = candidates.filter(item => matchesApplicationSearch(item, search));
      const total = matched.length;
      const items = matched.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
      res.json({ items: items.map(applicationDto), page: q.page, pageSize: q.pageSize,
        total, totalPages: Math.ceil(total / q.pageSize) });
      return;
    }
    const [total, items] = await Promise.all([
      db.application.count({ where }),
      db.application.findMany({ where, include,
        orderBy: [orderBy, { id: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    res.json({ items: items.map(applicationDto), page: q.page, pageSize: q.pageSize, total, totalPages: Math.ceil(total / q.pageSize) });
  }));

  router.get("/applications/export.csv", asyncRoute(async (req, res) => {
    const userId = ownerId(res);
    const deviceId = typeof req.query.deviceId === "string" && req.query.deviceId ? req.query.deviceId : undefined;
    const device = deviceId
      ? await db.device.findFirst({ where: { id: deviceId, ownerId: userId, revokedAt: null } })
      : await db.device.findFirst({ where: { ownerId: userId, revokedAt: null }, orderBy: { createdAt: "desc" } });
    const snapshot = device ? await db.scanSnapshot.findFirst({ where: { deviceId: device.id }, orderBy: { takenAt: "desc" } }) : null;
    const apps = snapshot ? await db.application.findMany({ where: { snapshotId: snapshot.id }, orderBy: [{ displayName: "asc" }, { id: "asc" }] }) : [];
    const rows: (string | null)[][] = [["Application", "Publisher", "Installed version", "Available version", "Update status", "Match status", "WinGet ID", "Installation scope", "Architecture", "Observed at", "Scan timestamp"]];
    for (const app of apps) rows.push([app.displayName, app.publisher, app.installedVersion, app.availableVersion, app.updateStatus, app.matchStatus, app.packageId, app.installScope, app.architecture, app.observedAt.toISOString(), snapshot?.takenAt.toISOString() ?? null]);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="updatex-applications.csv"');
    res.send(csv(rows));
  }));

  router.get("/applications/:id", asyncRoute(async (req, res) => {
    const app = await db.application.findFirst({
      where: { id: req.params.id, snapshot: { device: { ownerId: ownerId(res) } } },
      include: { snapshot: { select: { deviceId: true } },
        _count: { select: { observations: true } },
        observations: { orderBy: [{ evidenceType: "asc" }, { sourceKey: "asc" }] } },
    });
    if (!app) throw new ApiFailure(404, "NOT_FOUND", "Application not found.");
    const detail: ApplicationDetailDto = { ...applicationDto(app),
      observations: app.observations.map(observation => ({
        evidenceType: observation.evidenceType as "registry" | "winget" | "appx",
        displayName: observation.displayName, publisher: observation.publisher,
        installedVersion: observation.installedVersion, packageId: observation.packageId,
        registryHive: observation.registryHive, registryView: observation.registryView,
        registryKey: observation.registryKey, packageFamilyName: observation.packageFamilyName,
        installLocation: observation.installLocation,
        architecture: observation.architecture, installScope: observation.installScope,
      })) };
    res.json(detail);
  }));

  router.get("/applications/:id/release-info", asyncRoute(async (req, res) => {
    const app = await db.application.findFirst({ where: { id: req.params.id, snapshot: { device: { ownerId: ownerId(res) } } } });
    if (!app) throw new ApiFailure(404, "NOT_FOUND", "Application not found.");
    if (app.matchStatus !== "verified" || !app.packageId || !app.availableVersion) {
      res.json({ status: "unavailable", version: app.availableVersion ?? "Unknown", releaseDate: null, notes: null, officialUrl: null, source: null });
      return;
    }
    res.json(await officialReleaseInfo(app.packageId, app.availableVersion));
  }));

  router.get("/updates", asyncRoute(async (req, res) => {
    const q = ApplicationQuerySchema.parse({ ...req.query, update: "available" });
    const userId = ownerId(res);
    const device = q.deviceId
      ? await db.device.findFirst({ where: { id: q.deviceId, ownerId: userId, revokedAt: null } })
      : await db.device.findFirst({ where: { ownerId: userId, revokedAt: null }, orderBy: { createdAt: "desc" } });
    const snapshot = device ? await db.scanSnapshot.findFirst({ where: { deviceId: device.id }, orderBy: { takenAt: "desc" } }) : null;
    if (!snapshot) { res.json({ items: [], page: q.page, pageSize: q.pageSize, total: 0, totalPages: 0 }); return; }
    const where: Prisma.ApplicationWhereInput = { snapshotId: snapshot.id, updateStatus: "available", matchStatus: "verified" };
    const [total, items] = await Promise.all([
      db.application.count({ where }),
      db.application.findMany({ where, include: { snapshot: { select: { deviceId: true } },
        _count: { select: { observations: true } } },
        orderBy: [{ displayName: "asc" }, { id: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    res.json({ items: items.map(applicationDto), page: q.page, pageSize: q.pageSize, total, totalPages: Math.ceil(total / q.pageSize) });
  }));

  router.get("/history", asyncRoute(async (req, res) => {
    const q = HistoryQuerySchema.parse(req.query);
    const where = { userId: ownerId(res) };
    const [total, items] = await Promise.all([
      db.auditEvent.count({ where }),
      db.auditEvent.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    res.json({ items: items.map(auditDto), page: q.page, pageSize: q.pageSize, total, totalPages: Math.ceil(total / q.pageSize) });
  }));

  router.get("/update-history", asyncRoute(async (req, res) => {
    const q = HistoryQuerySchema.parse(req.query);
    const userId = ownerId(res);
    const deviceId = typeof req.query.deviceId === "string" && req.query.deviceId ? req.query.deviceId : undefined;
    const where: Prisma.UpdateJobWhereInput = { requestedBy: userId, ...(deviceId ? { deviceId } : {}) };
    const [total, jobs] = await Promise.all([
      db.updateJob.count({ where }),
      db.updateJob.findMany({ where, include: { application: { select: { displayName: true } }, events: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    const items: UpdateHistoryDto[] = jobs.map(job => ({
      id: job.id, deviceId: job.deviceId, applicationId: job.applicationId,
      applicationName: job.application.displayName, publisher: job.publisher,
      status: job.status as JobStatus, packageId: job.packageId, source: job.source,
      installedVersion: job.installedVersion, targetVersion: job.targetVersion,
      observedVersion: job.observedVersion, exitCode: job.exitCode,
      diagnosticCode: job.diagnosticCode, createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null, completedAt: job.completedAt?.toISOString() ?? null,
      events: job.events.map(event => ({ id: event.id, status: event.status, detail: event.detail,
        createdAt: event.createdAt.toISOString(), downloadPercent: event.downloadPercent,
        downloadedBytes: event.downloadedBytes === null ? null : Number(event.downloadedBytes),
        totalBytes: event.totalBytes === null ? null : Number(event.totalBytes) })),
    }));
    res.json({ items, page: q.page, pageSize: q.pageSize, total, totalPages: Math.ceil(total / q.pageSize) });
  }));

  router.get("/update-history/export.csv", asyncRoute(async (req, res) => {
    const userId = ownerId(res);
    const deviceId = typeof req.query.deviceId === "string" && req.query.deviceId ? req.query.deviceId : undefined;
    const where: Prisma.UpdateJobWhereInput = { requestedBy: userId, ...(deviceId ? { deviceId } : {}) };
    const jobs = await db.updateJob.findMany({ where, include: { application: { select: { displayName: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    const rows: (string | number | null)[][] = [["Application", "Publisher", "WinGet ID", "Before version", "Target version", "Verified installed version", "Update status", "Diagnostic code", "Exit code", "Requested at", "Started at", "Completed at"]];
    for (const job of jobs) rows.push([job.application.displayName, job.publisher, job.packageId, job.installedVersion, job.targetVersion, job.observedVersion, job.status, job.diagnosticCode, job.exitCode, job.createdAt.toISOString(), job.startedAt?.toISOString() ?? null, job.completedAt?.toISOString() ?? null]);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="updatex-update-history.csv"');
    res.send(csv(rows));
  }));

  router.get("/settings", asyncRoute(async (_req, res) => {
    const settings = await db.settings.findUnique({ where: { userId: ownerId(res) } });
    res.json({ theme: settings?.theme ?? "system", retentionDays: settings?.retentionDays ?? 365, scanReminderDays: settings?.scanReminderDays ?? 7 });
  }));

  router.patch("/settings", asyncRoute(async (req, res) => {
    const patch = SettingsPatchSchema.parse(req.body);
    const userId = ownerId(res);
    const settings = await db.settings.upsert({ where: { userId }, update: patch, create: { userId, ...patch, retentionDays: 365 } });
    await db.auditEvent.create({ data: { userId, action: patch.theme ? "settings.theme_changed" : "settings.scan_reminder_changed", detail: patch.theme ? `Theme set to ${patch.theme}` : `Scan reminder set to ${patch.scanReminderDays} days` } });
    res.json({ theme: settings.theme, retentionDays: settings.retentionDays, scanReminderDays: settings.scanReminderDays });
  }));

  return router;
}
