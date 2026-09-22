import {
  AppleCredentialError,
  AppleServerError,
} from './apple-server.js';

const BASE_RETRY_MS = 30_000;
const MAX_RETRY_MS = 6 * 60 * 60 * 1_000;

/** Exponential retry capped at six hours; attemptCount is incremented on claim. */
export function recoveryRetryDelayMs(attemptCount: number): number {
  const safeAttempt = Math.max(1, Math.min(32, Math.floor(attemptCount)));
  return Math.min(
    MAX_RETRY_MS,
    BASE_RETRY_MS * 2 ** Math.min(16, safeAttempt - 1)
  );
}

export function recoveryRetryAt(
  attemptCount: number,
  now = new Date()
): Date {
  return new Date(now.getTime() + recoveryRetryDelayMs(attemptCount));
}

export function recoveryBatchLimit(value = 100): number {
  if (!Number.isFinite(value)) return 100;
  return Math.max(1, Math.min(500, Math.floor(value)));
}

export function recoveryLeaseUntil(
  now = new Date(),
  leaseMs = 60_000
): Date {
  const safeLeaseMs = Math.max(30_000, Math.min(5 * 60_000, leaseMs));
  return new Date(now.getTime() + safeLeaseMs);
}

export type AppleRevocationFailureClass =
  | 'transient'
  | 'permanent'
  | 'configuration';

export function classifyAppleRevocationFailure(
  error: unknown
): AppleRevocationFailureClass {
  if (error instanceof AppleCredentialError) return 'permanent';
  if (error instanceof AppleServerError && error.kind === 'rejected') {
    // Only token-specific failures prove that retrying this credential cannot
    // work. Apple configuration/client-auth errors (for example
    // invalid_client) affect every account and must retain ciphertext while
    // operators repair the deployment. A global configuration failure must
    // never erase all users' recoverable credentials.
    return error.upstreamCode === 'invalid_token' ||
      error.upstreamCode === 'invalid_grant'
      ? 'permanent'
      : 'configuration';
  }
  // Network failures, malformed upstream responses, and unknown failures are
  // retried with a bounded policy before requiring manual action. This avoids
  // terminalizing privacy work because of a temporary Apple outage while also
  // preventing an account from remaining in `deleting` forever.
  return 'transient';
}

/** Bound privacy work: permanent failures stop immediately; outages get retries. */
export function shouldTerminalizeAppleRevocation(input: {
  failureClass: AppleRevocationFailureClass;
  attemptCount: number;
  revocationStartedAt: Date;
  now?: Date;
}): boolean {
  if (input.failureClass === 'permanent') return true;
  if (input.failureClass === 'configuration') return false;
  const now = input.now ?? new Date();
  const ageMs = Math.max(
    0,
    now.getTime() - input.revocationStartedAt.getTime()
  );
  return input.attemptCount >= 12 || ageMs >= 7 * 24 * 60 * 60 * 1_000;
}
