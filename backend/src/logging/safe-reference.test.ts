import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { safeLogReference } from './safe-reference.js';

const originalLogKey = process.env.LOG_REFERENCE_KEY;
const originalJwtSecret = process.env.JWT_SECRET;

afterEach(() => {
  if (originalLogKey === undefined) delete process.env.LOG_REFERENCE_KEY;
  else process.env.LOG_REFERENCE_KEY = originalLogKey;
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
});

test('redacts identifiers when no correlation key is configured', () => {
  delete process.env.LOG_REFERENCE_KEY;
  delete process.env.JWT_SECRET;
  assert.equal(safeLogReference('user', 'user-123'), 'user:redacted');
});

test('returns stable scoped HMAC references without exposing the value', () => {
  process.env.LOG_REFERENCE_KEY = 'test-only-high-entropy-log-key';
  const first = safeLogReference('user', 'user-123');
  const repeated = safeLogReference('user', 'user-123');
  const otherScope = safeLogReference('session', 'user-123');

  assert.equal(first, repeated);
  assert.notEqual(first, otherScope);
  assert.match(first ?? '', /^user:[a-f0-9]{20}$/);
  assert.equal(first?.includes('user-123'), false);
});

test('omits empty identifiers', () => {
  assert.equal(safeLogReference('user', ''), undefined);
  assert.equal(safeLogReference('user', undefined), undefined);
});
