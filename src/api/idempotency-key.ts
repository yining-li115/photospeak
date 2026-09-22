const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Format the durable mobile/server v2 key contract without storing payload. */
export function formatAiIdempotencyKey(uuid: string, nowMs: number): string {
  if (!UUID_V4_RE.test(uuid) || !Number.isFinite(nowMs) || nowMs <= 0) {
    throw new Error('Invalid AI idempotency key input');
  }
  return `v2.${Math.floor(nowMs / 1_000)}.${uuid.toLowerCase()}`;
}
