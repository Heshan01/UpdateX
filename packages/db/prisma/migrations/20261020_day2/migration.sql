-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "evidenceType" TEXT NOT NULL DEFAULT 'registry',
ADD COLUMN     "installScope" TEXT;

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "keyFingerprint" TEXT;

-- AlterTable
ALTER TABLE "ScanJob" ADD COLUMN     "leaseUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "UpdateJob" ADD COLUMN     "evidenceHash" TEXT,
ADD COLUMN     "executionStartedAt" TIMESTAMP(3),
ADD COLUMN     "leaseUntil" TIMESTAMP(3),
ADD COLUMN     "previewId" TEXT,
ADD COLUMN     "publisher" TEXT;

-- CreateTable
CREATE TABLE "PairingRequest" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "publicKeyPem" TEXT NOT NULL,
    "keyFingerprint" TEXT NOT NULL,
    "deviceName" TEXT NOT NULL,
    "agentVersion" TEXT NOT NULL,
    "osVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "ownerId" TEXT,
    "deviceId" TEXT,

    CONSTRAINT "PairingRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PairingNonce" (
    "pairingId" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PairingNonce_pkey" PRIMARY KEY ("pairingId","nonce")
);

-- CreateTable
CREATE TABLE "AgentNonce" (
    "deviceId" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentNonce_pkey" PRIMARY KEY ("deviceId","nonce")
);

-- CreateTable
CREATE TABLE "UpdatePreview" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "publisher" TEXT,
    "installedVersion" TEXT NOT NULL,
    "targetVersion" TEXT NOT NULL,
    "evidenceHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UpdatePreview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpdateEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UpdateEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PairingRequest_codeHash_key" ON "PairingRequest"("codeHash");

-- CreateIndex
CREATE INDEX "PairingRequest_expiresAt_idx" ON "PairingRequest"("expiresAt");

-- CreateIndex
CREATE INDEX "AgentNonce_createdAt_idx" ON "AgentNonce"("createdAt");

-- CreateIndex
CREATE INDEX "UpdatePreview_ownerId_expiresAt_idx" ON "UpdatePreview"("ownerId", "expiresAt");

-- CreateIndex
CREATE INDEX "UpdateEvent_jobId_createdAt_idx" ON "UpdateEvent"("jobId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Device_keyFingerprint_key" ON "Device"("keyFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "UpdateJob_previewId_key" ON "UpdateJob"("previewId");

-- AddForeignKey
ALTER TABLE "UpdateJob" ADD CONSTRAINT "UpdateJob_previewId_fkey" FOREIGN KEY ("previewId") REFERENCES "UpdatePreview"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PairingRequest" ADD CONSTRAINT "PairingRequest_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PairingRequest" ADD CONSTRAINT "PairingRequest_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PairingNonce" ADD CONSTRAINT "PairingNonce_pairingId_fkey" FOREIGN KEY ("pairingId") REFERENCES "PairingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentNonce" ADD CONSTRAINT "AgentNonce_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpdatePreview" ADD CONSTRAINT "UpdatePreview_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpdatePreview" ADD CONSTRAINT "UpdatePreview_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpdatePreview" ADD CONSTRAINT "UpdatePreview_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpdateEvent" ADD CONSTRAINT "UpdateEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "UpdateJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
