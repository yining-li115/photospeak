import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A deliberately non-routable 11-digit sentinel accepted only by the App
 * Review credential path. It starts with `10`, which the ordinary mainland
 * mobile-number validator rejects, so it cannot shadow a customer's account.
 *
 * The identifier is not a secret. Authentication still requires the fixed
 * six-digit code whose keyed digest stays server-side.
 */
export const APP_REVIEW_PHONE = '10000000000';

const CODE_RE = /^\d{6}$/;
const HMAC_RE = /^[a-f0-9]{64}$/;

export type AppReviewAccessConfig =
  | { enabled: false }
  | {
      enabled: true;
      phone: typeof APP_REVIEW_PHONE;
      codeHmac: Buffer;
      hmacKey: Buffer;
    };

interface AppReviewAccessEnv {
  enabled?: string;
  phone?: string;
  codeHmac?: string;
  hmacKey?: string;
}

/**
 * Fail closed: a partially configured or weak review credential must prevent
 * startup when the feature is explicitly enabled. Dormant values are allowed
 * so operators can disable access with one flag without deleting the digest.
 */
export function parseAppReviewAccessConfig(
  env: AppReviewAccessEnv
): AppReviewAccessConfig {
  if (env.enabled !== 'true') return { enabled: false };

  if (env.phone !== APP_REVIEW_PHONE) {
    throw new Error(
      `APP_REVIEW_PHONE must be the non-routable sentinel ${APP_REVIEW_PHONE}`
    );
  }
  const normalizedHmac = env.codeHmac?.trim().toLowerCase() ?? '';
  if (!HMAC_RE.test(normalizedHmac)) {
    throw new Error('APP_REVIEW_CODE_HMAC must be 64 lowercase hex characters');
  }
  const hmacKey = env.hmacKey ?? '';
  if (Buffer.byteLength(hmacKey, 'utf8') < 32) {
    throw new Error('App Review credential HMAC key must be at least 32 bytes');
  }
  return {
    enabled: true,
    phone: APP_REVIEW_PHONE,
    codeHmac: Buffer.from(normalizedHmac, 'hex'),
    hmacKey: Buffer.from(hmacKey, 'utf8'),
  };
}

export function isAppReviewPhone(
  config: AppReviewAccessConfig | undefined,
  phone: string
): boolean {
  return config?.enabled === true && phone === config.phone;
}

export function appReviewCodeHmac(
  hmacKey: string | Buffer,
  phone: string,
  code: string
): Buffer {
  return createHmac('sha256', hmacKey)
    .update(`photospeak:app-review:${phone}:${code}`, 'utf8')
    .digest();
}

export function verifyAppReviewCode(
  config: AppReviewAccessConfig | undefined,
  phone: string,
  code: string
): boolean {
  if (!config?.enabled || phone !== config.phone || !CODE_RE.test(code)) {
    return false;
  }
  const actual = appReviewCodeHmac(config.hmacKey, phone, code);
  return timingSafeEqual(actual, config.codeHmac);
}
