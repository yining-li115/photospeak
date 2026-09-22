import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_ENVELOPE_BYTES = 8 * 1024;
export interface RefreshReplayTokens {
  accessToken: string;
  refreshToken: string;
}

export interface RefreshReplayPayload {
  refreshToken: string;
}

export function materializeRefreshReplay(
  payload: RefreshReplayPayload,
  issueFreshAccessToken: () => string
): RefreshReplayTokens {
  return {
    accessToken: issueFreshAccessToken(),
    refreshToken: payload.refreshToken,
  };
}

export function isValidRefreshIdempotencyKey(value: string): boolean {
  return /^[A-Za-z0-9._~-]{16,128}$/.test(value);
}

export function hashRefreshIdempotencyKey(value: string): string {
  return createHash('sha256')
    .update('photospeak:refresh-idempotency:v1\0', 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

export function isRefreshReplayEligible(input: {
  expectedKeyHash: string;
  storedKeyHash: string | null;
  envelope: string | null;
  expiresAt: Date | null;
  revocationReason: string | null;
  now: Date;
}): boolean {
  return Boolean(
    input.storedKeyHash === input.expectedKeyHash &&
      input.envelope &&
      input.expiresAt &&
      input.expiresAt > input.now &&
      input.revocationReason === 'rotated'
  );
}

/**
 * Encrypted storage for the child refresh token of an already-completed
 * rotation. Access tokens are deliberately not persisted: an idempotent
 * retry may happen after the original access token expired, so the caller
 * must mint a fresh access token after re-checking the live session.
 * The derived key is domain-separated from JWT signing use; no plaintext token
 * or reversible idempotency key is stored in PostgreSQL.
 */
export class RefreshReplayVault {
  private readonly key: Buffer;

  constructor(jwtSecret: string) {
    if (jwtSecret.length < 32) throw new Error('JWT secret is too short');
    this.key = createHash('sha256')
      .update('photospeak:refresh-replay-key:v1\0', 'utf8')
      .update(jwtSecret, 'utf8')
      .digest();
  }

  seal(input: {
    payload: RefreshReplayPayload;
    oldTokenHash: string;
    idempotencyKeyHash: string;
    sessionId: string;
  }): string {
    const plaintext = Buffer.from(JSON.stringify(input.payload), 'utf8');
    if (plaintext.byteLength > MAX_ENVELOPE_BYTES / 2) {
      throw new Error('Refresh replay payload is too large');
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(replayAad(input));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  open(input: {
    envelope: string;
    oldTokenHash: string;
    idempotencyKeyHash: string;
    sessionId: string;
  }): RefreshReplayPayload {
    try {
      if (Buffer.byteLength(input.envelope, 'utf8') > MAX_ENVELOPE_BYTES) {
        throw new Error('oversized envelope');
      }
      const parts = input.envelope.split('.');
      if (parts.length !== 4 || parts[0] !== 'v1') {
        throw new Error('invalid envelope');
      }
      const iv = Buffer.from(parts[1], 'base64url');
      const tag = Buffer.from(parts[2], 'base64url');
      const ciphertext = Buffer.from(parts[3], 'base64url');
      if (
        iv.byteLength !== IV_BYTES ||
        tag.byteLength !== TAG_BYTES ||
        ciphertext.byteLength === 0
      ) {
        throw new Error('invalid envelope lengths');
      }
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(replayAad(input));
      decipher.setAuthTag(tag);
      const parsed: unknown = JSON.parse(
        Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]).toString('utf8')
      );
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('invalid replay payload');
      }
      const { refreshToken } = parsed as Record<string, unknown>;
      if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
        throw new Error('invalid replay tokens');
      }
      return { refreshToken };
    } catch {
      throw new Error('Refresh replay envelope is invalid');
    }
  }
}

function replayAad(input: {
  oldTokenHash: string;
  idempotencyKeyHash: string;
  sessionId: string;
}): Buffer {
  return Buffer.from(
    `photospeak:refresh-replay:v1:${input.sessionId}:${input.oldTokenHash}:${input.idempotencyKeyHash}`,
    'utf8'
  );
}
