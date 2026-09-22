import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RefreshReplayVault,
  hashRefreshIdempotencyKey,
  isRefreshReplayEligible,
  isValidRefreshIdempotencyKey,
  materializeRefreshReplay,
} from './refresh-replay.js';

test('refresh replay stores only an authenticated encrypted child refresh', () => {
  const vault = new RefreshReplayVault('s'.repeat(48));
  const idempotencyKeyHash = hashRefreshIdempotencyKey(
    '550e8400-e29b-41d4-a716-446655440000'
  );
  const binding = {
    oldTokenHash: 'old-token-hash',
    idempotencyKeyHash,
    sessionId: 'session-a',
  };
  const envelope = vault.seal({
    ...binding,
    payload: { refreshToken: 'refresh-secret' },
  });
  assert.doesNotMatch(envelope, /refresh-secret/);
  assert.deepEqual(vault.open({ envelope, ...binding }), {
    refreshToken: 'refresh-secret',
  });
  assert.throws(() =>
    vault.open({ envelope, ...binding, sessionId: 'session-b' })
  );
});

test('refresh replay requires the same key inside the bounded window', () => {
  const now = new Date('2026-09-19T12:00:00Z');
  const base = {
    expectedKeyHash: 'same',
    storedKeyHash: 'same',
    envelope: 'encrypted',
    expiresAt: new Date('2026-09-19T12:05:00Z'),
    revocationReason: 'rotated',
    now,
  };
  assert.equal(isRefreshReplayEligible(base), true);
  assert.equal(
    isRefreshReplayEligible({ ...base, expectedKeyHash: 'different' }),
    false
  );
  assert.equal(isRefreshReplayEligible({ ...base, expiresAt: now }), false);
});

test('a late replay mints a fresh access token while preserving the child refresh', () => {
  const initialAccessExpiresAt = Date.parse('2026-09-19T12:15:00Z');
  const replayedAt = Date.parse('2026-09-20T12:00:00Z');
  assert.ok(replayedAt > initialAccessExpiresAt);
  const tokens = materializeRefreshReplay(
    { refreshToken: 'same-child-refresh' },
    () => `fresh-access-issued-at-${replayedAt}`
  );
  assert.deepEqual(tokens, {
    accessToken: `fresh-access-issued-at-${replayedAt}`,
    refreshToken: 'same-child-refresh',
  });
});

test('refresh replay remains eligible after seven offline days until session expiry', () => {
  const rotationAt = new Date('2026-09-01T00:00:00Z');
  const afterEightDays = new Date('2026-09-09T00:00:00Z');
  assert.equal(
    isRefreshReplayEligible({
      expectedKeyHash: 'same',
      storedKeyHash: 'same',
      envelope: 'encrypted',
      expiresAt: new Date('2026-10-01T00:00:00Z'),
      revocationReason: 'rotated',
      now: afterEightDays,
    }),
    true
  );
  assert.ok(afterEightDays.getTime() - rotationAt.getTime() > 7 * 86_400_000);
});

test('refresh idempotency keys are high-entropy bounded header values', () => {
  assert.equal(
    isValidRefreshIdempotencyKey('550e8400-e29b-41d4-a716-446655440000'),
    true
  );
  assert.equal(isValidRefreshIdempotencyKey('short'), false);
  assert.equal(isValidRefreshIdempotencyKey('x'.repeat(129)), false);
  assert.notEqual(
    hashRefreshIdempotencyKey('550e8400-e29b-41d4-a716-446655440000'),
    '550e8400-e29b-41d4-a716-446655440000'
  );
});
