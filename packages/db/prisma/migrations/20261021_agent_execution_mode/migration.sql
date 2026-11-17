-- Additive capability state. Existing devices remain read-only until a signed heartbeat reports otherwise.
ALTER TABLE "Device" ADD COLUMN "executionMode" TEXT NOT NULL DEFAULT 'read_only';
