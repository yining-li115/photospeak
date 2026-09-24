/**
 * Server-side consent contract.
 *
 * The mobile application keeps its own copy because the agreement shown to a
 * user ships inside that binary. `scripts/consent-policy.test.mjs` is the
 * release-contract guard that prevents the two copies from drifting again.
 */
export const CURRENT_CONSENT_VERSION = '2026-09-22.1';

export interface ConsentFields {
  consent_version?: unknown;
  consent_accepted_at?: unknown;
}

export interface ValidConsentReceipt {
  version: typeof CURRENT_CONSENT_VERSION;
  acceptedAt: Date;
}

export function parseConsentReceipt(
  fields: ConsentFields,
  now = new Date()
): ValidConsentReceipt | null {
  if (fields.consent_version !== CURRENT_CONSENT_VERSION) return null;
  if (typeof fields.consent_accepted_at !== 'string') return null;

  const candidate = new Date(fields.consent_accepted_at);
  if (Number.isNaN(candidate.getTime())) return null;

  return {
    version: CURRENT_CONSENT_VERSION,
    // A device clock slightly ahead of the server must not create a future
    // legal receipt. Preserve the acceptance while normalizing its timestamp.
    acceptedAt: candidate <= now ? candidate : now,
  };
}
