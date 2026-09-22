import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APP_REVIEW_PHONE,
  appReviewCodeHmac,
  isAppReviewPhone,
  parseAppReviewAccessConfig,
  verifyAppReviewCode,
} from './app-review-access.js';

const HMAC_KEY = 'test-only-app-review-hmac-key-at-least-32-bytes';
const CODE = '731942';

test('review access is disabled unless explicitly enabled', () => {
  const config = parseAppReviewAccessConfig({
    enabled: 'false',
    phone: APP_REVIEW_PHONE,
    codeHmac: 'not-used-while-disabled',
  });
  assert.deepEqual(config, { enabled: false });
  assert.equal(isAppReviewPhone(config, APP_REVIEW_PHONE), false);
  assert.equal(verifyAppReviewCode(config, APP_REVIEW_PHONE, CODE), false);
});

test('review access accepts only the sentinel phone and keyed code digest', () => {
  const codeHmac = appReviewCodeHmac(
    HMAC_KEY,
    APP_REVIEW_PHONE,
    CODE
  ).toString('hex');
  const config = parseAppReviewAccessConfig({
    enabled: 'true',
    phone: APP_REVIEW_PHONE,
    codeHmac,
    hmacKey: HMAC_KEY,
  });
  assert.equal(isAppReviewPhone(config, APP_REVIEW_PHONE), true);
  assert.equal(verifyAppReviewCode(config, APP_REVIEW_PHONE, CODE), true);
  assert.equal(verifyAppReviewCode(config, APP_REVIEW_PHONE, '731943'), false);
  assert.equal(verifyAppReviewCode(config, '13800138000', CODE), false);
  assert.equal(verifyAppReviewCode(config, APP_REVIEW_PHONE, '12345'), false);
});

test('enabled review access rejects routable or partial configuration', () => {
  assert.throws(
    () =>
      parseAppReviewAccessConfig({
        enabled: 'true',
        phone: '13800138000',
        codeHmac: '0'.repeat(64),
        hmacKey: HMAC_KEY,
      }),
    /non-routable sentinel/
  );
  assert.throws(
    () =>
      parseAppReviewAccessConfig({
        enabled: 'true',
        phone: APP_REVIEW_PHONE,
        codeHmac: '0'.repeat(64),
        hmacKey: 'too-short',
      }),
    /at least 32 bytes/
  );
  assert.throws(
    () =>
      parseAppReviewAccessConfig({
        enabled: 'true',
        phone: APP_REVIEW_PHONE,
        codeHmac: 'invalid',
        hmacKey: HMAC_KEY,
      }),
    /64 lowercase hex/
  );
});
