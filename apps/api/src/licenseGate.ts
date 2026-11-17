import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { RequestHandler } from "express";
import { ApiFailure } from "./errors";
import { verifyLocalLicense } from "./localLicense";

const HEX64 = /^[a-f0-9]{64}$/;

function fingerprint(): string {
  const output = execFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe"),
    ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
    { encoding: "utf8", timeout: 3000, windowsHide: true });
  const guid = /MachineGuid\s+REG_SZ\s+([^\r\n]+)/i.exec(output)?.[1]?.trim();
  if (!guid) throw new Error("DEVICE_ID_UNAVAILABLE");
  return createHash("sha256").update(`UpdateX-device-v1:${guid}`).digest("hex");
}

function verifyOffline(): void {
  const file = process.env.UPDATE_X_LICENSE_VERIFIER_FILE;
  const hash = process.env.UPDATE_X_LICENSE_HASH;
  const activatedAt = process.env.UPDATE_X_LICENSE_ACTIVATED_AT;
  if (!file || !hash || !HEX64.test(hash) || !activatedAt ||
      !Number.isFinite(Date.parse(activatedAt)) || Date.parse(activatedAt) > Date.now() + 300000)
    throw new Error("LICENSE_REQUIRED");
  const manifest = JSON.parse(readFileSync(file, "utf8")) as
    { format?: number; algorithm?: string; keyHashes?: unknown };
  if (manifest.format !== 1 || manifest.algorithm !== "sha256" ||
      !Array.isArray(manifest.keyHashes) || manifest.keyHashes.length !== 50 ||
      new Set(manifest.keyHashes).size !== 50 ||
      !manifest.keyHashes.every(item => typeof item === "string" && HEX64.test(item)) ||
      !manifest.keyHashes.includes(hash)) throw new Error("LICENSE_INVALID");
  const device = fingerprint();
  if (process.env.UPDATE_X_LICENSE_DEVICE_ID !== device) throw new Error("DEVICE_MISMATCH");
}

export const packagedLicenseGate: RequestHandler = (req, _res, next) => {
  // Only health and exact-key activation are reachable before licensing.
  if (req.path === "/api/v1/health" ||
      (req.path === "/api/v1/license/activate" && req.method === "POST")) { next(); return; }
  try {
    const desktopProof = ["UPDATE_X_LICENSE_HASH", "UPDATE_X_LICENSE_ACTIVATED_AT", "UPDATE_X_LICENSE_DEVICE_ID"]
      .some(name => Boolean(process.env[name]));
    if (desktopProof) verifyOffline();
    else if (!verifyLocalLicense()) throw new Error("LICENSE_REQUIRED");
    next();
  }
  catch { next(new ApiFailure(423, "LICENSE_REQUIRED", "A valid offline UpdateX license is required.")); }
};
