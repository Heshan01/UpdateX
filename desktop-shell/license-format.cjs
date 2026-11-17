const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const KEY_PATTERN = /^UPDX(?:-[A-Z0-9]{5}){4}$/;
const HEX64 = /^[a-f0-9]{64}$/;

function normalizeKey(value) {
  const key = String(value ?? "").trim().toUpperCase();
  if (!KEY_PATTERN.test(key)) throw new Error("Invalid license key.");
  return key;
}
function keyHash(value) {
  const key = normalizeKey(value);
  return createHash("sha256").update(`UpdateX-license-v1:${key}`).digest("hex");
}
function readManifest(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("UpdateX license verifier is damaged."); }
  if (value?.format !== 1 || value.algorithm !== "sha256" || !Array.isArray(value.keyHashes) ||
      value.keyHashes.length !== 50 || new Set(value.keyHashes).size !== 50 ||
      !value.keyHashes.every(item => typeof item === "string" && HEX64.test(item)))
    throw new Error("UpdateX license verifier is invalid.");
  return new Set(value.keyHashes);
}
function deviceFingerprint() {
  let output;
  try {
    output = execFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe"),
      ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
      { encoding: "utf8", timeout: 3000, windowsHide: true });
  } catch { throw new Error("Windows device identity could not be read."); }
  const guid = /MachineGuid\s+REG_SZ\s+([^\r\n]+)/i.exec(output)?.[1]?.trim();
  if (!guid) throw new Error("Windows device identity is unavailable.");
  return createHash("sha256").update(`UpdateX-device-v1:${guid}`).digest("hex");
}
function activate(keyInput, hashes, device) {
  const key = normalizeKey(keyInput);
  const hash = keyHash(key);
  if (!hashes.has(hash)) throw new Error("Invalid license key.");
  if (!HEX64.test(device)) throw new Error("Windows device identity is invalid.");
  return { format: 1, keyHash: hash, device, activatedAt: new Date().toISOString(),
    maskedIdentifier: `UPDX-••••-••••-••••-${key.slice(-5)}` };
}
function validateActivation(record, hashes, device) {
  if (record?.format !== 1 || !HEX64.test(record.keyHash) || !hashes.has(record.keyHash) ||
      !HEX64.test(record.device) || record.device !== device ||
      typeof record.activatedAt !== "string" || !Number.isFinite(Date.parse(record.activatedAt)) ||
      Date.parse(record.activatedAt) > Date.now() + 300000 ||
      typeof record.maskedIdentifier !== "string" ||
      !/^UPDX-••••-••••-••••-[A-Z0-9]{5}$/.test(record.maskedIdentifier))
    throw new Error("Saved license activation is invalid. Enter a valid key again.");
  return record;
}

module.exports = { keyHash, readManifest, deviceFingerprint, activate, validateActivation };
