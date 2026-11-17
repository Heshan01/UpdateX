import { z } from "zod";
export { ZodError } from "zod";

export const ThemeSchema = z.enum(["system", "light", "dark"]);
export const MatchStatusSchema = z.enum(["verified", "ambiguous", "unmatched", "unsupported"]);
export const UpdateStatusSchema = z.enum([
  "available",
  "up_to_date",
  "unknown_version",
  "blocked_or_pinned",
  "unsupported",
  "source_unavailable",
  "store_managed",
  "no_verified_match",
  "unsupported_method",
  "update_unknown",
]);
export const JobStatusSchema = z.enum([
  "queued", "leased", "running", "verifying", "succeeded", "failed",
  "verification_failed", "reboot_required", "action_required", "cancelled", "expired", "execution_unknown",
]);
export const AgentCapabilitySchema = z.enum(["read_only", "update_enabled"]);
export const AgentHeartbeatSchema = z.object({ executionMode: AgentCapabilitySchema }).strict();

export const CredentialsSchema = z.object({
  username: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9_.-]+$/),
  password: z.string().min(12).max(200).refine(value => new TextEncoder().encode(value).length <= 72, "Password must be at most 72 UTF-8 bytes."),
}).strict();

export const SettingsPatchSchema = z.object({ theme: ThemeSchema.optional(), scanReminderDays: z.number().int().min(1).max(90).optional() }).strict()
  .refine(value => value.theme !== undefined || value.scanReminderDays !== undefined, "At least one setting is required.");

export const ApplicationQuerySchema = z.object({
  deviceId: z.string().optional(),
  search: z.string().trim().max(120).optional(),
  installationType: z.enum(["windows_app"]).optional(),
  match: MatchStatusSchema.optional(),
  update: UpdateStatusSchema.optional(),
  sort: z.enum(["name", "publisher", "installedVersion", "updateStatus"]).default("name"),
  direction: z.enum(["asc", "desc"]).default("asc"),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(20),
}).strict();

export const HistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(20),
}).strict();

export type Theme = z.infer<typeof ThemeSchema>;
export type MatchStatus = z.infer<typeof MatchStatusSchema>;
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type ApplicationQuery = z.infer<typeof ApplicationQuerySchema>;

export type ApiError = { code: string; message: string; requestId: string; details?: unknown };
export type AuthState = { initialized: boolean; accountAvailable?: boolean; authenticated: boolean; mode?: "guest" | "account"; username?: string; csrfToken?: string };
export type DeviceDto = {
  id: string;
  name: string;
  agentVersion: string | null;
  osVersion: string | null;
  lastSeenAt: string | null;
  lastHeartbeatAt: string | null;
  executionMode: z.infer<typeof AgentCapabilitySchema>;
  revokedAt: string | null;
  connection: "online" | "offline" | "revoked";
};
export type AgentActivityDto = { device: DeviceDto; activeScans: number; activeUpdates: number };
export type ApplicationDto = {
  id: string;
  deviceId: string;
  displayName: string;
  publisher: string | null;
  installedVersion: string | null;
  packageId: string | null;
  source: string | null;
  availableVersion: string | null;
  matchStatus: MatchStatus;
  updateStatus: UpdateStatus;
  matchReason: string | null;
  observedAt: string;
  installScope: string | null;
  architecture: string | null;
  installationType: string;
  observationCount: number;
};
export type ApplicationObservationDto = {
  evidenceType: "registry" | "winget" | "appx";
  displayName: string;
  publisher: string | null;
  installedVersion: string | null;
  packageId: string | null;
  registryHive: string | null;
  registryView: string | null;
  registryKey: string | null;
  packageFamilyName?: string | null;
  installLocation: string | null;
  architecture: string | null;
  installScope: string | null;
};
export type ApplicationDetailDto = ApplicationDto & { observations: ApplicationObservationDto[] };
export type Page<T> = { items: T[]; page: number; pageSize: number; total: number; totalPages: number };
export type DashboardDto = {
  inventoryCount: number;
  updateCount: number;
  unsupportedCount: number;
  lastScanAt: string | null;
  agent: DeviceDto | null;
  recentActivity: HistoryItemDto[];
  scanReminderDays: number;
};
export type HistoryItemDto = {
  id: string;
  kind: "scan" | "update" | "audit";
  title: string;
  detail: string | null;
  status: JobStatus | "info";
  createdAt: string;
};
export type SettingsDto = { theme: Theme; retentionDays: number; scanReminderDays: number };
export type ReleaseInfoDto = { status: "available" | "unavailable"; version: string; releaseDate: string | null; notes: string | null; officialUrl: string | null; source: string | null };
export type UpdateProgressEventDto = { id: string; status: string; detail: string | null; createdAt: string; downloadPercent?: number | null; downloadedBytes?: number | null; totalBytes?: number | null };
export type UpdateHistoryDto = UpdateJobDto & { applicationName: string; publisher: string | null; events: UpdateProgressEventDto[] };

const limitedText = (max: number) => z.string().trim().min(1).max(max);
export const PackageIdSchema = z.string().min(3).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._-]+$/);
export const PairingStartSchema = z.object({
  deviceName: limitedText(80), agentVersion: limitedText(40), osVersion: limitedText(80),
  publicKeyPem: z.string().min(100).max(1000),
}).strict();
export const PairingCodeSchema = z.object({ code: z.string().regex(/^[A-Z2-9]{6}-[A-Z2-9]{6}$/) }).strict();
export const PairingApproveSchema = PairingCodeSchema.extend({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) });

export const ScanApplicationSchema = z.object({
  stableKey: z.string().regex(/^[a-f0-9]{64}$/),
  displayName: limitedText(256),
  publisher: limitedText(256).nullable(),
  installedVersion: limitedText(128).nullable(),
  packageId: PackageIdSchema.nullable(),
  source: z.literal("winget").nullable(),
  availableVersion: limitedText(128).nullable(),
  matchStatus: MatchStatusSchema,
  updateStatus: UpdateStatusSchema,
  matchReason: z.string().max(500).nullable(),
  evidenceType: z.enum(["registry", "winget", "appx"]),
  installScope: z.enum(["user", "machine", "unknown"]).nullable(),
  architecture: z.enum(["x86", "x64", "arm64"]).nullable(),
  installLocation: z.string().max(1024).nullable(),
  installationType: z.enum(["desktop", "web_app", "winget_only", "windows_app"]),
  observations: z.array(z.object({
    sourceKey: z.string().regex(/^[a-f0-9]{64}$/),
    evidenceType: z.enum(["registry", "winget", "appx"]),
    displayName: limitedText(256),
    publisher: limitedText(256).nullable(),
    installedVersion: limitedText(128).nullable(),
    packageId: PackageIdSchema.nullable(),
    registryHive: z.enum(["CurrentUser", "LocalMachine"]).nullable(),
    registryView: z.enum(["Registry32", "Registry64"]).nullable(),
    registryKey: z.string().max(512).nullable(),
    packageFamilyName: z.string().max(512).nullable().optional(),
    installLocation: z.string().max(1024).nullable(),
    displayIcon: z.string().max(1024).nullable(),
    architecture: z.enum(["x86", "x64", "arm64"]).nullable(),
    installScope: z.enum(["user", "machine", "unknown"]).nullable(),
    windowsInstaller: z.boolean().nullable(),
  }).strict()).min(1).max(50),
}).strict().superRefine((item, ctx) => {
  if (item.updateStatus === "available" &&
      (item.matchStatus !== "verified" || !item.packageId || item.source !== "winget" ||
       !item.installedVersion || !item.availableVersion || !item.publisher)) {
    ctx.addIssue({ code: "custom", message: "An available update requires a verified package, publisher and both versions." });
  }
  if (item.source === "winget" && !item.packageId) {
    ctx.addIssue({ code: "custom", message: "A WinGet source requires a package ID." });
  }
});
export const ScanResultSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  applications: z.array(ScanApplicationSchema).max(2000),
  rawObservationCount: z.number().int().min(0).max(5000),
  errorCode: z.string().regex(/^[A-Z0-9_]{1,64}$/).nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.status === "failed" && !value.errorCode) ctx.addIssue({ code: "custom", message: "A failed scan requires an error code." });
  if (value.status === "failed" && value.applications.length) ctx.addIssue({ code: "custom", message: "A failed scan cannot submit partial inventory." });
  if (value.status === "failed" && value.rawObservationCount !== 0) ctx.addIssue({ code: "custom", message: "A failed scan cannot report persisted observations." });
  if (new Set(value.applications.map(item => item.stableKey)).size !== value.applications.length) {
    ctx.addIssue({ code: "custom", message: "Scan stable keys must be unique." });
  }
  const sourceKeys = value.applications.flatMap(item => item.observations.map(observation => observation.sourceKey));
  if (value.status === "succeeded" &&
      (sourceKeys.length !== value.rawObservationCount || new Set(sourceKeys).size !== sourceKeys.length)) {
    ctx.addIssue({ code: "custom", message: "Every raw observation must belong to exactly one logical application." });
  }
});

export const UpdateExecuteSchema = z.object({
  previewId: z.string().cuid(), confirmation: z.literal(true),
  idempotencyKey: z.string().uuid(),
}).strict();
export const UpdateResultSchema = z.object({
  status: z.enum(["succeeded", "failed", "verification_failed", "reboot_required", "action_required", "execution_unknown"]),
  observedVersion: limitedText(128).nullable(),
  exitCode: z.number().int().nullable(),
  diagnosticCode: z.string().regex(/^[A-Z0-9_]{1,64}$/).nullable(),
  executionStarted: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.status === "succeeded" && (!value.executionStarted || !value.observedVersion || value.exitCode !== 0)) {
    ctx.addIssue({ code: "custom", message: "Success requires a completed execution and observed version." });
  }
});
export const UpdateProgressSchema = z.object({
  stage: z.enum(["downloading", "installing"]),
  percent: z.number().int().min(0).max(100).nullable(),
  downloadedBytes: z.number().int().min(0).safe().nullable(),
  totalBytes: z.number().int().positive().safe().nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.stage !== "downloading" && (value.percent !== null || value.downloadedBytes !== null || value.totalBytes !== null))
    ctx.addIssue({ code: "custom", message: "Only downloads may have transfer metrics." });
  if ((value.downloadedBytes === null) !== (value.totalBytes === null) ||
      (value.downloadedBytes !== null && value.totalBytes !== null && value.downloadedBytes > value.totalBytes))
    ctx.addIssue({ code: "custom", message: "Download byte values must be a valid pair." });
});

export type ScanApplicationInput = z.infer<typeof ScanApplicationSchema>;
export type ScanObservationInput = ScanApplicationInput["observations"][number];
export type ScanResultInput = z.infer<typeof ScanResultSchema>;
export type UpdateResultInput = z.infer<typeof UpdateResultSchema>;
export type PairingLookupDto = { deviceName: string; agentVersion: string; osVersion: string; fingerprint: string; expiresAt: string };
export type ScanJobDto = { id: string; deviceId: string; status: JobStatus; createdAt: string; startedAt: string | null; completedAt: string | null; errorCode: string | null };
export type UpdatePreviewDto = { id: string; applicationId: string; deviceId: string; packageId: string; source: "winget"; publisher: string; installedVersion: string; targetVersion: string; expiresAt: string; warnings: string[] };
export type UpdateJobDto = { id: string; deviceId: string; applicationId: string; status: JobStatus; packageId: string; source: string; installedVersion: string | null; targetVersion: string; observedVersion: string | null; exitCode: number | null; diagnosticCode: string | null; createdAt: string; startedAt: string | null; completedAt: string | null; progressStage?: "downloading" | "installing" | null; downloadPercent?: number | null; downloadedBytes?: number | null; totalBytes?: number | null; progressAt?: string | null };
export type DownloadDto = UpdateJobDto & { applicationName: string; publisher: string | null };
