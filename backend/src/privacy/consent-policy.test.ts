import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CURRENT_CONSENT_VERSION,
  parseConsentReceipt,
} from './consent-policy.js';

test('accepts the current consent contract', () => {
  const acceptedAt = '2026-09-24T00:00:00.000Z';
  const receipt = parseConsentReceipt(
    {
      consent_version: CURRENT_CONSENT_VERSION,
      consent_accepted_at: acceptedAt,
    },
    new Date('2026-09-24T01:00:00.000Z')
  );

  assert.equal(receipt?.version, CURRENT_CONSENT_VERSION);
  assert.equal(receipt?.acceptedAt.toISOString(), acceptedAt);
});

test('rejects stale versions and malformed timestamps', () => {
  assert.equal(
    parseConsentReceipt({
      consent_version: 'stale-policy',
      consent_accepted_at: '2026-09-24T00:00:00.000Z',
    }),
    null
  );
  assert.equal(
    parseConsentReceipt({
      consent_version: CURRENT_CONSENT_VERSION,
      consent_accepted_at: 'not-a-date',
    }),
    null
  );
});

test('clamps a future device timestamp to server time', () => {
  const now = new Date('2026-09-24T01:00:00.000Z');
  const receipt = parseConsentReceipt(
    {
      consent_version: CURRENT_CONSENT_VERSION,
      consent_accepted_at: '2026-09-24T02:00:00.000Z',
    },
    now
  );

  assert.equal(receipt?.acceptedAt.toISOString(), now.toISOString());
});
