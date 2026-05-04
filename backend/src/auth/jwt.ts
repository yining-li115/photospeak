import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  throw new Error('JWT_SECRET is required');
}
if (SECRET.length < 32) {
  throw new Error(
    'JWT_SECRET too short (need >= 32 chars). Generate with: openssl rand -base64 48'
  );
}

const ACCESS_EXPIRES = process.env.JWT_EXPIRES_IN ?? '7d';
const REFRESH_EXPIRES = process.env.JWT_REFRESH_EXPIRES_IN ?? '30d';

export interface AccessPayload {
  /** User id (sub claim). */
  sub: string;
  /** Token kind discriminator so refresh tokens can't be used as access tokens and vice-versa. */
  kind: 'access' | 'refresh';
}

export function signAccess(userId: string): string {
  return jwt.sign({ sub: userId, kind: 'access' }, SECRET as string, {
    expiresIn: ACCESS_EXPIRES as jwt.SignOptions['expiresIn'],
  });
}

export function signRefresh(userId: string): string {
  return jwt.sign({ sub: userId, kind: 'refresh' }, SECRET as string, {
    expiresIn: REFRESH_EXPIRES as jwt.SignOptions['expiresIn'],
  });
}

/**
 * Returns the decoded payload if valid. Throws if the token is
 * expired, malformed, or the wrong kind.
 */
export function verifyToken(
  token: string,
  expectedKind: 'access' | 'refresh'
): AccessPayload {
  const decoded = jwt.verify(token, SECRET as string) as AccessPayload;
  if (decoded.kind !== expectedKind) {
    throw new Error(`Wrong token kind: expected ${expectedKind}`);
  }
  return decoded;
}

/** ms since epoch when a refresh token issued now would expire. */
export function refreshExpiresAt(): Date {
  // Approximate by parsing JWT_REFRESH_EXPIRES_IN. Default 30 days.
  // We only use this to write the DB row's expires_at column; the
  // real source of truth is the token's exp claim.
  const m = REFRESH_EXPIRES.match(/^(\d+)([smhdwy])$/);
  if (!m) return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const sec =
    unit === 's' ? n :
    unit === 'm' ? n * 60 :
    unit === 'h' ? n * 60 * 60 :
    unit === 'd' ? n * 24 * 60 * 60 :
    unit === 'w' ? n * 7 * 24 * 60 * 60 :
    n * 365 * 24 * 60 * 60; // y
  return new Date(Date.now() + sec * 1000);
}
