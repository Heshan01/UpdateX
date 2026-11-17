import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { RequestHandler } from "express";
import type { PrismaClient } from "@updatepilot/db";
import { ApiFailure, asyncRoute } from "./errors";

const rawBodies = new WeakMap<IncomingMessage, Buffer>();
export function storeRawBody(req: IncomingMessage, body: Buffer) { rawBodies.set(req, Buffer.from(body)); }

const MAX_SKEW_SECONDS = 120;
const noncePattern = /^[A-Za-z0-9_-]{22,64}$/;
const devicePattern = /^[a-z0-9]{20,40}$/;

export function sha256(value: Buffer | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function keyFingerprint(pem: string): string {
  let key: crypto.KeyObject;
  try { key = crypto.createPublicKey(pem); }
  catch { throw new ApiFailure(400, "INVALID_AGENT_KEY", "The agent public key is invalid."); }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new ApiFailure(400, "INVALID_AGENT_KEY", "The agent must use a P-256 public key.");
  }
  return sha256(key.export({ type: "spki", format: "der" }) as Buffer);
}

function signedTime(value: string | undefined): number {
  if (!value || !/^\d{10}$/.test(value)) throw new ApiFailure(401, "AGENT_SIGNATURE_INVALID", "Agent timestamp is invalid.");
  const seconds = Number(value);
  if (Math.abs(Date.now() / 1000 - seconds) > MAX_SKEW_SECONDS) {
    throw new ApiFailure(401, "AGENT_SIGNATURE_EXPIRED", "Agent clock differs from this computer.");
  }
  return seconds;
}

function signedNonce(value: string | undefined): string {
  if (!value || !noncePattern.test(value)) throw new ApiFailure(401, "AGENT_SIGNATURE_INVALID", "Agent nonce is invalid.");
  return value;
}

function verify(pem: string, message: string, encoded: string | undefined) {
  if (!encoded || !/^[A-Za-z0-9_-]{80,100}$/.test(encoded)) {
    throw new ApiFailure(401, "AGENT_SIGNATURE_INVALID", "Agent signature is missing.");
  }
  let valid = false;
  try {
    valid = crypto.verify("sha256", Buffer.from(message, "utf8"),
      { key: pem, dsaEncoding: "ieee-p1363" }, Buffer.from(encoded, "base64url"));
  } catch { /* Invalid encoding is an authentication failure. */ }
  if (!valid) throw new ApiFailure(401, "AGENT_SIGNATURE_INVALID", "Agent signature is invalid.");
}

export function agentAuth(db: PrismaClient): RequestHandler {
  return asyncRoute(async (req, res, next) => {
    const deviceId = req.header("X-UP-Device-Id") ?? "";
    if (!devicePattern.test(deviceId)) throw new ApiFailure(401, "AGENT_ID_INVALID", "Agent identity is invalid.");
    const timestamp = req.header("X-UP-Timestamp") ?? undefined;
    signedTime(timestamp);
    const nonce = signedNonce(req.header("X-UP-Nonce") ?? undefined);
    const device = await db.device.findUnique({ where: { id: deviceId } });
    if (!device || device.revokedAt || !device.publicKeyPem) {
      throw new ApiFailure(401, "AGENT_REVOKED", "The agent is not paired or has been revoked.");
    }
    const bodyHash = sha256(rawBodies.get(req) ?? Buffer.alloc(0));
    const message = [req.method.toUpperCase(), req.originalUrl, bodyHash, deviceId, timestamp, nonce].join("\n");
    verify(device.publicKeyPem, message, req.header("X-UP-Signature") ?? undefined);
    try { await db.agentNonce.create({ data: { deviceId, nonce } }); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
        throw new ApiFailure(409, "AGENT_REPLAY", "This agent request was already received.");
      }
      throw error;
    }
    // A revocation or approved key rotation may have committed after the
    // initial read. Reject that request even if its old signature was valid.
    const current = await db.device.updateMany({ where: {
      id: deviceId, revokedAt: null, publicKeyPem: device.publicKeyPem,
    }, data: { lastSeenAt: new Date() } });
    if (current.count !== 1)
      throw new ApiFailure(401, "AGENT_REVOKED", "The agent key changed or was revoked.");
    res.locals.deviceId = deviceId;
    res.locals.ownerId = device.ownerId;
    next();
  });
}

export function verifyPairingPoll(db: PrismaClient): RequestHandler {
  return asyncRoute(async (req, res, next) => {
    const pairingId = req.params.id ?? "";
    if (!devicePattern.test(pairingId)) throw new ApiFailure(401, "PAIRING_INVALID", "Pairing request is invalid.");
    const pairing = await db.pairingRequest.findUnique({ where: { id: pairingId } });
    if (!pairing || (!pairing.approvedAt && pairing.expiresAt <= new Date()) ||
        (pairing.approvedAt && pairing.approvedAt.getTime() < Date.now() - 24 * 60 * 60_000))
      throw new ApiFailure(410, "PAIRING_EXPIRED", "Pairing request expired.");
    const timestamp = req.header("X-UP-Timestamp") ?? undefined;
    signedTime(timestamp);
    const nonce = signedNonce(req.header("X-UP-Nonce") ?? undefined);
    verify(pairing.publicKeyPem, ["PAIR", pairingId, timestamp, nonce].join("\n"), req.header("X-UP-Signature") ?? undefined);
    try { await db.pairingNonce.create({ data: { pairingId, nonce } }); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
        throw new ApiFailure(409, "AGENT_REPLAY", "This pairing request was already received.");
      }
      throw error;
    }
    res.locals.pairing = pairing;
    next();
  });
}

export function newPairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(12);
  const value = Array.from(bytes, byte => alphabet[byte % alphabet.length]).join("");
  return `${value.slice(0, 6)}-${value.slice(6)}`;
}
