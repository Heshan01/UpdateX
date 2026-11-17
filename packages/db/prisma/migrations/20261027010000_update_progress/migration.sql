-- Additive progress metadata. Existing jobs and events remain untouched.
ALTER TABLE "UpdateJob" ADD COLUMN "progressStage" TEXT,
ADD COLUMN "downloadPercent" INTEGER,
ADD COLUMN "downloadedBytes" BIGINT,
ADD COLUMN "totalBytes" BIGINT,
ADD COLUMN "progressAt" TIMESTAMP(3);
ALTER TABLE "UpdateEvent" ADD COLUMN "downloadPercent" INTEGER,
ADD COLUMN "downloadedBytes" BIGINT,
ADD COLUMN "totalBytes" BIGINT;
ALTER TABLE "ApplicationObservation" ADD COLUMN "packageFamilyName" TEXT;
