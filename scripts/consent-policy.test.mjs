import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CURRENT_POLICY_VERSION,
  isCurrentConsentReceipt,
  requireCurrentConsentReceipt,
} from '../src/privacy/consent-policy.ts';
import {
  CURRENT_CONSENT_VERSION as BACKEND_CONSENT_VERSION,
} from '../backend/src/privacy/consent-policy.ts';

const currentReceipt = {
  version: CURRENT_POLICY_VERSION,
  acceptedAt: '2026-09-24T00:00:00.000Z',
};

test('mobile and backend ship the same consent contract version', () => {
  assert.equal(CURRENT_POLICY_VERSION, BACKEND_CONSENT_VERSION);
});

test('accepts only a well-formed receipt for the current policy', () => {
  assert.equal(isCurrentConsentReceipt(currentReceipt), true);
  assert.equal(
    isCurrentConsentReceipt({ ...currentReceipt, version: 'older-policy' }),
    false
  );
  assert.equal(
    isCurrentConsentReceipt({ ...currentReceipt, acceptedAt: 'not-a-date' }),
    false
  );
  assert.equal(isCurrentConsentReceipt(null), false);
});

test('authentication receives the exact accepted receipt', () => {
  assert.equal(requireCurrentConsentReceipt(currentReceipt), currentReceipt);
  assert.throws(
    () => requireCurrentConsentReceipt(null),
    /请先阅读并同意当前用户协议与隐私政策/
  );
});
