import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyRefreshAttempt } from './session-policy.js';

const authenticatedAt = new Date('2026-09-19T12:00:00.000Z');
const expiresAt = new Date('2026-10-19T12:00:00.000Z');
const active = {
  expiresAt,
  usedAt: null,
  revokedAt: null,
  replacedByTokenHash: null,
};

test('a matching unused refresh row is active', () => {
  assert.equal(
    classifyRefreshAttempt({
      stored: active,
      tokenExpSeconds: expiresAt.getTime() / 1_000,
      tokenAuthTimeSeconds: authenticatedAt.getTime() / 1_000,
      sessionAuthenticatedAt: authenticatedAt,
      now: new Date('2026-09-20T12:00:00.000Z'),
    }),
    'active'
  );
});

test('used, replaced, missing, or mismatched rows signal family reuse', () => {
  const base = {
    tokenExpSeconds: expiresAt.getTime() / 1_000,
    tokenAuthTimeSeconds: authenticatedAt.getTime() / 1_000,
    sessionAuthenticatedAt: authenticatedAt,
    now: new Date('2026-09-20T12:00:00.000Z'),
  };
  assert.equal(classifyRefreshAttempt(base), 'reuse_detected');
  assert.equal(
    classifyRefreshAttempt({
      ...base,
      stored: { ...active, usedAt: new Date() },
    }),
    'reuse_detected'
  );
  assert.equal(
    classifyRefreshAttempt({
      ...base,
      stored: { ...active, replacedByTokenHash: 'next' },
    }),
    'reuse_detected'
  );
  assert.equal(
    classifyRefreshAttempt({ ...base, stored: active, tokenExpSeconds: 1 }),
    'reuse_detected'
  );
});
