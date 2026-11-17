import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RequestHandler } from "express";
import { ApiFailure, asyncRoute } from "./errors";

const keyPattern = /^UPDX(?:-[A-Z0-9]{5}){4}$/;
const hex64 = /^[a-f0-9]{64}$/;
const activationPath = () => path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
  "UpdateX", "license-activation-api.bin");
const verifierPath = () => process.env.UPDATE_X_LICENSE_VERIFIER_FILE ??
  path.resolve(__dirname, "../../../desktop-shell/license-verifier.json");

type Activation = { format: 1; keyHash: string; device: string; activatedAt: string };
let cached: { modified: number; verifierModified: number; valid: boolean } | null = null;

function hashes(): Set<string> {
  const manifest = JSON.parse(readFileSync(verifierPath(), "utf8")) as
    { format?: number; algorithm?: string; keyHashes?: unknown };
  if (manifest.format !== 1 || manifest.algorithm !== "sha256" ||
      !Array.isArray(manifest.keyHashes) || manifest.keyHashes.length !== 50 ||
      new Set(manifest.keyHashes).size !== 50 ||
      !manifest.keyHashes.every(hash => typeof hash === "string" && hex64.test(hash)))
    throw new Error("LICENSE_VERIFIER_INVALID");
  return new Set(manifest.keyHashes);
}

function fingerprint(): string {
  const output = execFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe"),
    ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
    { encoding: "utf8", timeout: 3000, windowsHide: true });
  const guid = /MachineGuid\s+REG_SZ\s+([^\r\n]+)/i.exec(output)?.[1]?.trim();
  if (!guid) throw new Error("DEVICE_ID_UNAVAILABLE");
  return createHash("sha256").update(`UpdateX-device-v1:${guid}`).digest("hex");
}

function dpapi(action: "protect" | "unprotect", input: string): string {
  if (process.platform !== "win32") throw new Error("WINDOWS_REQUIRED");
  const script = path.resolve(__dirname, "../scripts/license-storage.ps1");
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-File", script, action],
    { input, encoding: "utf8", timeout: 5000, maxBuffer: 8192, windowsHide: true });
  if (result.status !== 0 || result.error) throw new Error("LICENSE_STORAGE_UNAVAILABLE");
  return result.stdout.trim();
}

function valid(record: Activation): boolean {
  return record?.format === 1 && typeof record.keyHash === "string" && hex64.test(record.keyHash) &&
    hashes().has(record.keyHash) && record.device === fingerprint() &&
    typeof record.activatedAt === "string" && Number.isFinite(Date.parse(record.activatedAt)) &&
    Date.parse(record.activatedAt) <= Date.now() + 300000;
}

// This path is used only by the separately run local API. A packaged desktop
// receives license proof from Electron and never falls back to this file.
export function verifyLocalLicense(): boolean {
  if (process.env.UPDATE_X_PACKAGED_API === "1") return false;
  try {
    const file = activationPath();
    const modified = statSync(file).mtimeMs;
    const verifierModified = statSync(verifierPath()).mtimeMs;
    if (cached?.modified === modified && cached.verifierModified === verifierModified) return cached.valid;
    const record = JSON.parse(dpapi("unprotect", readFileSync(file, "utf8"))) as Activation;
    const approved = valid(record);
    cached = { modified, verifierModified, valid: approved };
    return approved;
  } catch { cached = null; return false; }
}

export const activateLocalLicense: RequestHandler = asyncRoute(async (req, res) => {
  if (process.env.UPDATE_X_PACKAGED_API === "1")
    throw new ApiFailure(403, "DESKTOP_ACTIVATION_REQUIRED", "Use the UpdateX desktop activation screen.");
  const key = typeof req.body?.key === "string" ? req.body.key.trim().toUpperCase() : "";
  if (!keyPattern.test(key)) throw new ApiFailure(400, "INVALID_LICENSE_KEY", "Enter a valid UpdateX license key.");
  const keyHash = createHash("sha256").update(`UpdateX-license-v1:${key}`).digest("hex");
  try {
    if (!hashes().has(keyHash)) throw new ApiFailure(400, "INVALID_LICENSE_KEY", "That license key is not valid.");
    const record: Activation = { format: 1, keyHash, device: fingerprint(), activatedAt: new Date().toISOString() };
    const file = activationPath();
    mkdirSync(path.dirname(file), { recursive: true });
    const pending = `${file}.${randomUUID()}.tmp`;
    writeFileSync(pending, dpapi("protect", JSON.stringify(record)), { mode: 0o600 });
    renameSync(pending, file);
    cached = null;
    res.json({ activated: true });
  } catch (error) {
    if (error instanceof ApiFailure) throw error;
    throw new ApiFailure(503, "LICENSE_ACTIVATION_UNAVAILABLE", "Local license activation is unavailable. Check Windows secure storage and the verifier file.");
  }
});
