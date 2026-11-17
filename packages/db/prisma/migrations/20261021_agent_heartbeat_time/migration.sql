-- Additive heartbeat time. Existing rows remain null until the rebuilt agent reports a signed heartbeat.
ALTER TABLE "Device" ADD COLUMN "lastHeartbeatAt" TIMESTAMP(3);
