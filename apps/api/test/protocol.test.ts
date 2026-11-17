import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentHeartbeatSchema, ScanResultSchema, UpdateResultSchema } from "@updatepilot/contracts";

const fixture = (name: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname,
  "../../../packages/contracts/fixtures", name), "utf8")) as unknown;

describe("agent wire fixtures shared with the C# suite", () => {
  it("accepts the read-only heartbeat and rejects an unrecognized capability", () => {
    expect(AgentHeartbeatSchema.parse(fixture("agent-heartbeat.json"))).toEqual({ executionMode: "read_only" });
    expect(AgentHeartbeatSchema.safeParse({ executionMode: "admin" }).success).toBe(false);
  });
  it("accepts a failure without inventory and rejects partial failed scans", () => {
    expect(ScanResultSchema.parse(fixture("scan-failure.json")).status).toBe("failed");
    expect(ScanResultSchema.safeParse({ status: "failed", applications: [], rawObservationCount: 1,
      errorCode: "SCAN_FAILED" }).success).toBe(false);
  });
  it("accepts a preflight failure and never treats it as execution success", () => {
    expect(UpdateResultSchema.parse(fixture("update-action-required.json")).executionStarted).toBe(false);
    expect(UpdateResultSchema.safeParse({ status: "succeeded", observedVersion: null, exitCode: 0,
      diagnosticCode: null, executionStarted: true }).success).toBe(false);
  });
});
