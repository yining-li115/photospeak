import { randomUUID } from 'node:crypto';
import jwt, { type JwtPayload } from 'jsonwebtoken';

const ALGORITHM = 'HS256' as const;
const ISSUER = 'photospeak-api';
const AUDIENCE = 'photospeak-deletion-status';
const CLOCK_TOLERANCE_SECONDS = 5;
const RECEIPT_TTL_SECONDS = 400 * 86_400;
const MAX_KEYS = 32;
const KEY_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export interface DeletionReceiptPayload extends JwtPayload {
  sub: string;
  kind: 'deletion_receipt';
  jti: string;
  iat: number;
  exp: number;
}

export interface IssuedDeletionReceipt {
  token: string;
  expiresAt: Date;
}

export interface DeletionReceiptConfig {
  currentKeyId: string;
  keys: Readonly<Record<string, Uint8Array>>;
}

/**
 * A narrow, long-lived account-deletion receipt with an independent key ring.
 * It is not an access credential and must be accepted only by the deletion
 * status endpoint. Keeping old `kid` entries for at least 400 days makes JWT
 * access-key rotation independent from deletion reconciliation.
 */
export class DeletionReceiptService {
  private readonly currentKeyId: string;
  private readonly keys: ReadonlyMap<string, Buffer>;

  constructor(config: DeletionReceiptConfig) {
    validateKeyId(config.currentKeyId);
    const entries = Object.entries(config.keys);
    if (entries.length === 0 || entries.length > MAX_KEYS) {
      throw new Error(
        `DELETION_RECEIPT_KEYS must contain 1-${MAX_KEYS} keys`
      );
    }
    const keys = new Map<string, Buffer>();
    for (const [keyId, value] of entries) {
      validateKeyId(keyId);
      const key = Buffer.from(value);
      if (key.byteLength !== 32) {
        throw new Error(
          `Deletion receipt key ${keyId} must decode to exactly 32 bytes`
        );
      }
      keys.set(keyId, key);
    }
    if (!keys.has(config.currentKeyId)) {
      throw new Error(
        'DELETION_RECEIPT_CURRENT_KID is missing from DELETION_RECEIPT_KEYS'
      );
    }
    this.currentKeyId = config.currentKeyId;
    this.keys = keys;
  }

  issue(userId: string, now = new Date()): IssuedDeletionReceipt {
    validateUserId(userId);
    const issuedAt = Math.floor(now.getTime() / 1_000);
    if (!Number.isSafeInteger(issuedAt)) throw new Error('Invalid receipt time');
    const expiresAtSeconds = issuedAt + RECEIPT_TTL_SECONDS;
    const token = jwt.sign(
      {
        sub: userId,
        kind: 'deletion_receipt',
        iat: issuedAt,
        exp: expiresAtSeconds,
      },
      this.keys.get(this.currentKeyId)!,
      {
        algorithm: ALGORITHM,
        issuer: ISSUER,
        audience: AUDIENCE,
        jwtid: randomUUID(),
        keyid: this.currentKeyId,
      }
    );
    return { token, expiresAt: new Date(expiresAtSeconds * 1_000) };
  }

  verify(token: string, now = new Date()): DeletionReceiptPayload {
    if (!token || token.length > 8_192) {
      throw new Error('Invalid deletion receipt');
    }
    const complete = jwt.decode(token, { complete: true });
    if (
      !complete ||
      typeof complete !== 'object' ||
      complete.header.alg !== ALGORITHM ||
      typeof complete.header.kid !== 'string'
    ) {
      throw new Error('Invalid deletion receipt header');
    }
    validateKeyId(complete.header.kid);
    const key = this.keys.get(complete.header.kid);
    if (!key) throw new Error('Unknown deletion receipt key');

    const decoded = jwt.verify(token, key, {
      algorithms: [ALGORITHM],
      issuer: ISSUER,
      audience: AUDIENCE,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      maxAge: RECEIPT_TTL_SECONDS,
      clockTimestamp: Math.floor(now.getTime() / 1_000),
    }) as unknown as DeletionReceiptPayload;
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    if (
      decoded.kind !== 'deletion_receipt' ||
      typeof decoded.sub !== 'string' ||
      decoded.sub.length === 0 ||
      decoded.sub.length > 128 ||
      typeof decoded.jti !== 'string' ||
      decoded.jti.length === 0 ||
      !Number.isInteger(decoded.iat) ||
      !Number.isInteger(decoded.exp) ||
      decoded.exp <= decoded.iat ||
      decoded.exp - decoded.iat !== RECEIPT_TTL_SECONDS ||
      decoded.iat > nowSeconds + CLOCK_TOLERANCE_SECONDS
    ) {
      throw new Error('Invalid deletion receipt claims');
    }
    return decoded;
  }
}

export function createDeletionReceiptServiceFromEnv(): DeletionReceiptService {
  const currentKeyId = process.env.DELETION_RECEIPT_CURRENT_KID;
  const rawKeys = process.env.DELETION_RECEIPT_KEYS;
  if (!currentKeyId) {
    throw new Error('DELETION_RECEIPT_CURRENT_KID is required');
  }
  if (!rawKeys) throw new Error('DELETION_RECEIPT_KEYS is required');
  return new DeletionReceiptService({
    currentKeyId,
    keys: parseDeletionReceiptKeys(rawKeys),
  });
}

export function parseDeletionReceiptKeys(
  raw: string
): Readonly<Record<string, Uint8Array>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('DELETION_RECEIPT_KEYS must be a JSON object');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('DELETION_RECEIPT_KEYS must be a JSON object');
  }
  const result: Record<string, Uint8Array> = {};
  for (const [keyId, encoded] of Object.entries(parsed)) {
    validateKeyId(keyId);
    if (typeof encoded !== 'string' || encoded.length > 128) {
      throw new Error(`Deletion receipt key ${keyId} must be base64 text`);
    }
    const decoded = Buffer.from(encoded, 'base64');
    if (
      decoded.byteLength !== 32 ||
      decoded.toString('base64').replace(/=+$/, '') !==
        encoded.replace(/=+$/, '')
    ) {
      throw new Error(
        `Deletion receipt key ${keyId} must be exactly 32 bytes in base64`
      );
    }
    result[keyId] = decoded;
  }
  return result;
}

export function deletionReceiptPublicConfig() {
  return {
    algorithm: ALGORITHM,
    issuer: ISSUER,
    audience: AUDIENCE,
    ttlSeconds: RECEIPT_TTL_SECONDS,
  };
}

function validateKeyId(keyId: string): void {
  if (!KEY_ID_RE.test(keyId)) {
    throw new Error('Deletion receipt key id is invalid');
  }
}

function validateUserId(userId: string): void {
  if (!userId || userId.length > 128) {
    throw new Error('Deletion receipt user id is invalid');
  }
}
