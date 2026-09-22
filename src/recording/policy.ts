/** Product-level recording limits, kept independent from React/native code. */
export const RECORDING_TARGET_MS = 60_000;
export const RECORDING_GRACE_MS = 10_000;
export const RECORDING_MAX_MS = RECORDING_TARGET_MS + RECORDING_GRACE_MS;

export type RecordingPeriod = 'idle' | 'main' | 'grace' | 'finished';

export interface RecordingCountdown {
  period: Exclude<RecordingPeriod, 'idle'>;
  remainingMs: number;
}

/**
 * Convert elapsed time into the two-stage countdown shown by the UI. Values
 * are clamped so timer jitter never renders a negative number.
 */
export function getRecordingCountdown(elapsedMs: number): RecordingCountdown {
  const elapsed = Math.max(0, elapsedMs);
  if (elapsed < RECORDING_TARGET_MS) {
    return {
      period: 'main',
      remainingMs: RECORDING_TARGET_MS - elapsed,
    };
  }
  if (elapsed < RECORDING_MAX_MS) {
    return {
      period: 'grace',
      remainingMs: RECORDING_MAX_MS - elapsed,
    };
  }
  return { period: 'finished', remainingMs: 0 };
}
