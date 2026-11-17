PRAGMA foreign_keys=ON;

CREATE TABLE "User" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "username" TEXT NOT NULL COLLATE NOCASE,
  "passwordHash" TEXT NOT NULL,
  "accountEnabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

CREATE TABLE "Session" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "csrfToken" TEXT NOT NULL,
  "mode" TEXT NOT NULL DEFAULT 'account',
  "expiresAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_expiresAt_idx" ON "Session"("userId", "expiresAt");

CREATE TABLE "Settings" (
  "userId" TEXT NOT NULL PRIMARY KEY,
  "theme" TEXT NOT NULL DEFAULT 'system',
  "retentionDays" INTEGER NOT NULL DEFAULT 365,
  "scanReminderDays" INTEGER NOT NULL DEFAULT 7,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "Settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "Device" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "agentVersion" TEXT,
  "osVersion" TEXT,
  "lastSeenAt" DATETIME,
  "lastHeartbeatAt" DATETIME,
  "executionMode" TEXT NOT NULL DEFAULT 'read_only',
  "revokedAt" DATETIME,
  "publicKeyPem" TEXT,
  "keyFingerprint" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Device_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Device_keyFingerprint_key" ON "Device"("keyFingerprint");
CREATE INDEX "Device_ownerId_createdAt_idx" ON "Device"("ownerId", "createdAt");

CREATE TABLE "ScanJob" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "deviceId" TEXT NOT NULL,
  "requestedBy" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "errorCode" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" DATETIME,
  "completedAt" DATETIME,
  "leaseUntil" DATETIME,
  CONSTRAINT "ScanJob_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ScanJob_requestedBy_fkey" FOREIGN KEY ("requestedBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ScanJob_deviceId_createdAt_idx" ON "ScanJob"("deviceId", "createdAt");

CREATE TABLE "ScanSnapshot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "deviceId" TEXT NOT NULL,
  "scanJobId" TEXT NOT NULL,
  "takenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rawObservationCount" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ScanSnapshot_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ScanSnapshot_scanJobId_fkey" FOREIGN KEY ("scanJobId") REFERENCES "ScanJob"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ScanSnapshot_scanJobId_key" ON "ScanSnapshot"("scanJobId");
CREATE INDEX "ScanSnapshot_deviceId_takenAt_idx" ON "ScanSnapshot"("deviceId", "takenAt");

CREATE TABLE "Application" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "snapshotId" TEXT NOT NULL,
  "stableKey" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "publisher" TEXT,
  "installedVersion" TEXT,
  "packageId" TEXT,
  "source" TEXT,
  "availableVersion" TEXT,
  "matchStatus" TEXT NOT NULL DEFAULT 'unmatched',
  "updateStatus" TEXT NOT NULL DEFAULT 'unsupported',
  "matchReason" TEXT,
  "evidenceType" TEXT NOT NULL DEFAULT 'registry',
  "installScope" TEXT,
  "architecture" TEXT,
  "installLocation" TEXT,
  "installationType" TEXT NOT NULL DEFAULT 'unknown',
  "observedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Application_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "ScanSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Application_snapshotId_stableKey_key" ON "Application"("snapshotId", "stableKey");
CREATE INDEX "Application_snapshotId_displayName_id_idx" ON "Application"("snapshotId", "displayName", "id");
CREATE INDEX "Application_snapshotId_updateStatus_idx" ON "Application"("snapshotId", "updateStatus");

CREATE TABLE "ApplicationObservation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "applicationId" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "evidenceType" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "publisher" TEXT,
  "installedVersion" TEXT,
  "packageId" TEXT,
  "registryHive" TEXT,
  "registryView" TEXT,
  "registryKey" TEXT,
  "packageFamilyName" TEXT,
  "installLocation" TEXT,
  "displayIcon" TEXT,
  "architecture" TEXT,
  "installScope" TEXT,
  "windowsInstaller" BOOLEAN,
  CONSTRAINT "ApplicationObservation_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ApplicationObservation_applicationId_sourceKey_key" ON "ApplicationObservation"("applicationId", "sourceKey");
CREATE INDEX "ApplicationObservation_applicationId_evidenceType_idx" ON "ApplicationObservation"("applicationId", "evidenceType");

CREATE TABLE "UpdatePreview" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "publisher" TEXT,
  "installedVersion" TEXT NOT NULL,
  "targetVersion" TEXT NOT NULL,
  "evidenceHash" TEXT NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  "consumedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UpdatePreview_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "UpdatePreview_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "UpdatePreview_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "UpdatePreview_ownerId_expiresAt_idx" ON "UpdatePreview"("ownerId", "expiresAt");

CREATE TABLE "UpdateJob" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "deviceId" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "requestedBy" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "packageId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "installedVersion" TEXT,
  "targetVersion" TEXT NOT NULL,
  "observedVersion" TEXT,
  "exitCode" INTEGER,
  "diagnosticCode" TEXT,
  "progressStage" TEXT,
  "downloadPercent" INTEGER,
  "downloadedBytes" BIGINT,
  "totalBytes" BIGINT,
  "progressAt" DATETIME,
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" DATETIME,
  "completedAt" DATETIME,
  "leaseUntil" DATETIME,
  "executionStartedAt" DATETIME,
  "previewId" TEXT,
  "publisher" TEXT,
  "evidenceHash" TEXT,
  CONSTRAINT "UpdateJob_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "UpdateJob_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "UpdateJob_requestedBy_fkey" FOREIGN KEY ("requestedBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "UpdateJob_previewId_fkey" FOREIGN KEY ("previewId") REFERENCES "UpdatePreview"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "UpdateJob_previewId_key" ON "UpdateJob"("previewId");
CREATE UNIQUE INDEX "UpdateJob_requestedBy_idempotencyKey_key" ON "UpdateJob"("requestedBy", "idempotencyKey");
CREATE INDEX "UpdateJob_deviceId_createdAt_idx" ON "UpdateJob"("deviceId", "createdAt");

CREATE TABLE "PairingRequest" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "codeHash" TEXT NOT NULL,
  "publicKeyPem" TEXT NOT NULL,
  "keyFingerprint" TEXT NOT NULL,
  "deviceName" TEXT NOT NULL,
  "agentVersion" TEXT NOT NULL,
  "osVersion" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" DATETIME NOT NULL,
  "approvedAt" DATETIME,
  "ownerId" TEXT,
  "deviceId" TEXT,
  CONSTRAINT "PairingRequest_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "PairingRequest_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PairingRequest_codeHash_key" ON "PairingRequest"("codeHash");
CREATE INDEX "PairingRequest_expiresAt_idx" ON "PairingRequest"("expiresAt");

CREATE TABLE "PairingNonce" (
  "pairingId" TEXT NOT NULL,
  "nonce" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("pairingId", "nonce"),
  CONSTRAINT "PairingNonce_pairingId_fkey" FOREIGN KEY ("pairingId") REFERENCES "PairingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AgentNonce" (
  "deviceId" TEXT NOT NULL,
  "nonce" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("deviceId", "nonce"),
  CONSTRAINT "AgentNonce_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AgentNonce_createdAt_idx" ON "AgentNonce"("createdAt");

CREATE TABLE "UpdateEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "jobId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "detail" TEXT,
  "downloadPercent" INTEGER,
  "downloadedBytes" BIGINT,
  "totalBytes" BIGINT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UpdateEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "UpdateJob"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "UpdateEvent_jobId_createdAt_idx" ON "UpdateEvent"("jobId", "createdAt");

CREATE TABLE "AuditEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "deviceId" TEXT,
  "kind" TEXT NOT NULL DEFAULT 'audit',
  "action" TEXT NOT NULL,
  "target" TEXT,
  "detail" TEXT,
  "status" TEXT NOT NULL DEFAULT 'info',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AuditEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "AuditEvent_userId_createdAt_idx" ON "AuditEvent"("userId", "createdAt");
