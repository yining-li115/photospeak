import { createHmac } from 'node:crypto';

/**
 * Produce a stable, non-reversible reference for correlating production logs.
 * Raw account, session, request, phone, and IP identifiers must stay out of
 * application logs. Production should configure LOG_REFERENCE_KEY; JWT_SECRET
 * is a safe migration fallback because it is already high entropy and
 * server-only. When neither exists (for example, an isolated unit test), the
 * value is fully redacted rather than logged in clear text.
 */
export function safeLogReference(
  scope: string,
  value: string | null | undefined
): string | undefined {
  if (!value) return undefined;
  const key =
    process.env.LOG_REFERENCE_KEY?.trim() || process.env.JWT_SECRET?.trim();
  if (!key) return `${scope}:redacted`;
  const digest = createHmac('sha256', key)
    .update(scope, 'utf8')
    .update('\0', 'utf8')
    .update(value, 'utf8')
    .digest('hex')
    .slice(0, 20);
  return `${scope}:${digest}`;
}
