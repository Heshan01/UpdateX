-- Preserve all existing snapshots and application rows. New scans record source provenance.
ALTER TABLE "ScanSnapshot" ADD COLUMN "rawObservationCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Application" ADD COLUMN "architecture" TEXT,
ADD COLUMN "installLocation" TEXT,
ADD COLUMN "installationType" TEXT NOT NULL DEFAULT 'unknown';

CREATE TABLE "ApplicationObservation" (
    "id" TEXT NOT NULL,
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
    "installLocation" TEXT,
    "displayIcon" TEXT,
    "architecture" TEXT,
    "installScope" TEXT,
    "windowsInstaller" BOOLEAN,
    CONSTRAINT "ApplicationObservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApplicationObservation_applicationId_sourceKey_key"
ON "ApplicationObservation"("applicationId", "sourceKey");
CREATE INDEX "ApplicationObservation_applicationId_evidenceType_idx"
ON "ApplicationObservation"("applicationId", "evidenceType");
ALTER TABLE "ApplicationObservation" ADD CONSTRAINT "ApplicationObservation_applicationId_fkey"
FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
