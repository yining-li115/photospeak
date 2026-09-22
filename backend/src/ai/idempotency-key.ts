const DAY_MS = 24 * 60 * 60 * 1_000;
const MINUTE_MS = 60 * 1_000;

export const AI_IDEMPOTENCY_KEY_MAX_AGE_MS = 400 * DAY_MS;
export const AI_IDEMPOTENCY_TOMBSTONE_CLEANUP_MARGIN_MS = 7 * DAY_MS;
// Modern mobile devices normally synchronize their clocks automatically. Ten
// minutes is intentionally generous for transient drift without turning a
// disaster-recovery fence into a full-day outage.
export const AI_IDEMPOTENCY_KEY_FUTURE_SKEW_MS = 10 * MINUTE_MS;

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSIONED_KEY_RE = /^v2\.([1-9][0-9]{9,10})\.(.+)$/;

export interface ParsedAiIdempotencyKey {
  version: 'legacy_uuid' | 'v2';
  createdAt: Date | null;
  dedupeExpiresAt: Date | null;
}

/** Parse the operator-controlled UTC fence installed after a database restore. */
export function parseAiRecoveryFenceCutoff(
  value: string | undefined,
  now = new Date()
): Date | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(normalized)) {
    throw new Error(
      'AI_IDEMPOTENCY_RECOVERY_FENCE_CUTOFF must be an ISO-8601 UTC timestamp'
    );
  }
  const timestamp = new Date(normalized);
  if (
    !Number.isFinite(timestamp.getTime()) ||
    timestamp.getTime() > now.getTime() + AI_IDEMPOTENCY_KEY_FUTURE_SKEW_MS
  ) {
    throw new Error('AI_IDEMPOTENCY_RECOVERY_FENCE_CUTOFF is invalid');
  }
  return timestamp;
}

/**
 * A missing pre-fence operation may have existed after the restored backup.
 * Legacy UUIDs have no trustworthy issue time, so unknown ones fail closed
 * whenever a recovery fence has ever been installed.
 */
export function shouldFenceUnknownAiIdempotencyKey(
  key: ParsedAiIdempotencyKey,
  recoveryFenceCutoff: Date | null
): boolean {
  if (!recoveryFenceCutoff) return false;
  // createdAt is supplied by the client and may legitimately be ahead by the
  // protocol's accepted clock skew. A key dispatched just before traffic was
  // stopped can therefore look newer than the operator cutoff. Fence through
  // cutoff + skew so a fast device clock cannot reopen the duplicate-charge
  // window after a database rollback.
  const effectiveCutoff =
    recoveryFenceCutoff.getTime() + AI_IDEMPOTENCY_KEY_FUTURE_SKEW_MS;
  return key.createdAt === null || key.createdAt.getTime() <= effectiveCutoff;
}

export class AiIdempotencyKeyValidationError extends Error {
  constructor(
    public readonly code:
      | 'IDEMPOTENCY_KEY_INVALID'
      | 'IDEMPOTENCY_KEY_EXPIRED',
    public readonly status: 400 | 410
  ) {
    super(code);
    this.name = 'AiIdempotencyKeyValidationError';
  }
}

/**
 * Versioned keys make lifetime tombstones bounded without making an old key
 * executable after its row is purged. Legacy beta UUIDs intentionally have no
 * expiry and therefore remain tombstones until their account is deleted.
 */
export function parseAiIdempotencyKey(
  value: string,
  now: Date
): ParsedAiIdempotencyKey {
  if (UUID_V4_RE.test(value)) {
    return {
      version: 'legacy_uuid',
      createdAt: null,
      dedupeExpiresAt: null,
    };
  }

  const match = VERSIONED_KEY_RE.exec(value);
  if (!match || !UUID_V4_RE.test(match[2])) {
    throw new AiIdempotencyKeyValidationError('IDEMPOTENCY_KEY_INVALID', 400);
  }
  const epochSeconds = Number(match[1]);
  const createdAtMs = epochSeconds * 1_000;
  if (
    !Number.isSafeInteger(epochSeconds) ||
    createdAtMs > now.getTime() + AI_IDEMPOTENCY_KEY_FUTURE_SKEW_MS
  ) {
    throw new AiIdempotencyKeyValidationError('IDEMPOTENCY_KEY_INVALID', 400);
  }
  const dedupeExpiresAtMs = createdAtMs + AI_IDEMPOTENCY_KEY_MAX_AGE_MS;
  if (dedupeExpiresAtMs <= now.getTime()) {
    // This check runs before lookup. The same answer is therefore guaranteed
    // even after the corresponding tombstone has been safely purged.
    throw new AiIdempotencyKeyValidationError('IDEMPOTENCY_KEY_EXPIRED', 410);
  }
  return {
    version: 'v2',
    createdAt: new Date(createdAtMs),
    dedupeExpiresAt: new Date(dedupeExpiresAtMs),
  };
}
