export interface RefreshAttemptRecord {
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  replacedByTokenHash: string | null;
}

export type RefreshAttemptState = 'active' | 'invalid' | 'reuse_detected';

/** Pure policy used by the transactional session service and unit tests. */
export function classifyRefreshAttempt(input: {
  stored?: RefreshAttemptRecord;
  tokenExpSeconds: number;
  tokenAuthTimeSeconds: number;
  sessionAuthenticatedAt: Date;
  now: Date;
}): RefreshAttemptState {
  const { stored } = input;
  if (!stored) return 'reuse_detected';
  if (
    Math.abs(stored.expiresAt.getTime() - input.tokenExpSeconds * 1_000) >=
      1_000 ||
    Math.abs(
      input.sessionAuthenticatedAt.getTime() -
        input.tokenAuthTimeSeconds * 1_000
    ) >= 1_000
  ) {
    return 'reuse_detected';
  }
  if (stored.usedAt || stored.revokedAt || stored.replacedByTokenHash) {
    return 'reuse_detected';
  }
  if (stored.expiresAt <= input.now) return 'invalid';
  return 'active';
}
