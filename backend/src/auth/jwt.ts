import { createHash, randomUUID } from 'node:crypto';
import jwt, { type JwtPayload } from 'jsonwebtoken';

const ALGORITHM = 'HS256' as const;
const CLOCK_TOLERANCE_SECONDS = 5;

export function parseDurationSeconds(
  value: string,
  options: { name: string; min: number; max: number }
): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(value.trim());
  if (!match) {
    throw new Error(`${options.name} must use s/m/h/d syntax`);
  }
  const amount = Number(match[1]);
  const multiplier =
    match[2] === 's'
      ? 1
      : match[2] === 'm'
        ? 60
        : match[2] === 'h'
          ? 3_600
          : 86_400;
  const seconds = amount * multiplier;
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < options.min ||
    seconds > options.max
  ) {
    throw new Error(
      `${options.name} must be between ${options.min}s and ${options.max}s`
    );
  }
  return seconds;
}

const rawSecret = process.env.JWT_SECRET;
if (!rawSecret) throw new Error('JWT_SECRET is required');
if (rawSecret.length < 32) {
  throw new Error(
    'JWT_SECRET too short (need >= 32 chars). Generate with: openssl rand -base64 48'
  );
}
const SECRET: string = rawSecret;

const ISSUER = process.env.JWT_ISSUER || 'photospeak-api';
const AUDIENCE = process.env.JWT_AUDIENCE || 'photospeak-mobile';
const ACCESS_TTL_SECONDS = parseDurationSeconds(
  process.env.JWT_EXPIRES_IN || '15m',
  { name: 'JWT_EXPIRES_IN', min: 5 * 60, max: 60 * 60 }
);
const REFRESH_TTL_SECONDS = parseDurationSeconds(
  process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  { name: 'JWT_REFRESH_EXPIRES_IN', min: 24 * 60 * 60, max: 90 * 86_400 }
);
export const RECENT_AUTH_MAX_AGE_SECONDS = (() => {
  const value = Number(process.env.AUTH_RECENT_MAX_AGE_SECONDS || 600);
  if (!Number.isInteger(value) || value < 60 || value > 3_600) {
    throw new Error('AUTH_RECENT_MAX_AGE_SECONDS must be an integer 60-3600');
  }
  return value;
})();

export interface TokenContext {
  userId: string;
  sessionId: string;
  authenticatedAt: Date;
}

export interface AuthTokenPayload extends JwtPayload {
  sub: string;
  kind: 'access' | 'refresh';
  sid: string;
  auth_time: number;
  jti: string;
  iat: number;
  exp: number;
}

export interface IssuedToken {
  token: string;
  expiresAt: Date;
  payload: AuthTokenPayload;
}

function issueToken(
  kind: 'access' | 'refresh',
  context: TokenContext,
  absoluteExpiresAt?: Date
): IssuedToken {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const defaultTtl = kind === 'access' ? ACCESS_TTL_SECONDS : REFRESH_TTL_SECONDS;
  const expiresSeconds = absoluteExpiresAt
    ? Math.floor(absoluteExpiresAt.getTime() / 1_000)
    : nowSeconds + defaultTtl;
  if (expiresSeconds <= nowSeconds) throw new Error('Token expiry is not future');
  if (expiresSeconds - nowSeconds > defaultTtl + CLOCK_TOLERANCE_SECONDS) {
    throw new Error('Token expiry exceeds configured TTL');
  }

  const token = jwt.sign(
    {
      sub: context.userId,
      kind,
      sid: context.sessionId,
      auth_time: Math.floor(context.authenticatedAt.getTime() / 1_000),
      exp: expiresSeconds,
    },
    SECRET,
    {
      algorithm: ALGORITHM,
      issuer: ISSUER,
      audience: AUDIENCE,
      jwtid: randomUUID(),
    }
  );
  const payload = jwt.decode(token) as AuthTokenPayload | null;
  if (!payload?.exp || !payload.iat || !payload.jti) {
    throw new Error('Failed to encode JWT timestamps');
  }
  return {
    token,
    expiresAt: new Date(payload.exp * 1_000),
    payload,
  };
}

export function issueAccessToken(context: TokenContext): IssuedToken {
  return issueToken('access', context);
}

export function issueRefreshToken(
  context: TokenContext,
  absoluteExpiresAt?: Date
): IssuedToken {
  return issueToken('refresh', context, absoluteExpiresAt);
}

/** Store only a one-way fingerprint of refresh tokens in PostgreSQL. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function verifyToken(
  token: string,
  expectedKind: 'access' | 'refresh'
): AuthTokenPayload {
  const configuredTtl =
    expectedKind === 'access' ? ACCESS_TTL_SECONDS : REFRESH_TTL_SECONDS;
  return verifyTokenWithPolicy(token, expectedKind, {
    ignoreExpiration: false,
    maxAgeSeconds: configuredTtl + CLOCK_TOLERANCE_SECONDS,
  });
}

function verifyTokenWithPolicy(
  token: string,
  expectedKind: 'access' | 'refresh',
  policy: { ignoreExpiration: boolean; maxAgeSeconds: number }
): AuthTokenPayload {
  const decoded = jwt.verify(token, SECRET, {
    algorithms: [ALGORITHM],
    issuer: ISSUER,
    audience: AUDIENCE,
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
    ignoreExpiration: policy.ignoreExpiration,
    maxAge: policy.maxAgeSeconds,
  }) as unknown as AuthTokenPayload;
  const configuredTtl =
    expectedKind === 'access' ? ACCESS_TTL_SECONDS : REFRESH_TTL_SECONDS;
  const nowSeconds = Math.floor(Date.now() / 1_000);
  if (
    decoded.kind !== expectedKind ||
    typeof decoded.sub !== 'string' ||
    decoded.sub.length === 0 ||
    decoded.sub.length > 128 ||
    typeof decoded.sid !== 'string' ||
    decoded.sid.length === 0 ||
    decoded.sid.length > 128 ||
    typeof decoded.jti !== 'string' ||
    !Number.isInteger(decoded.iat) ||
    !Number.isInteger(decoded.exp) ||
    !Number.isInteger(decoded.auth_time) ||
    decoded.exp <= decoded.iat ||
    decoded.exp - decoded.iat > configuredTtl + CLOCK_TOLERANCE_SECONDS ||
    decoded.iat > nowSeconds + CLOCK_TOLERANCE_SECONDS ||
    decoded.auth_time > decoded.iat + CLOCK_TOLERANCE_SECONDS
  ) {
    throw new Error(`Invalid ${expectedKind} token claims`);
  }
  return decoded;
}

export function isRecentAuthentication(
  authenticatedAt: Date,
  now = new Date(),
  maxAgeSeconds = RECENT_AUTH_MAX_AGE_SECONDS
): boolean {
  const ageMs = now.getTime() - authenticatedAt.getTime();
  return ageMs >= -CLOCK_TOLERANCE_SECONDS * 1_000 && ageMs <= maxAgeSeconds * 1_000;
}

export function jwtPublicConfig() {
  return {
    algorithm: ALGORITHM,
    issuer: ISSUER,
    audience: AUDIENCE,
    accessTtlSeconds: ACCESS_TTL_SECONDS,
    refreshTtlSeconds: REFRESH_TTL_SECONDS,
    recentAuthMaxAgeSeconds: RECENT_AUTH_MAX_AGE_SECONDS,
  };
}
