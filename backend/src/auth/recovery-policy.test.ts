import assert from 'node:assert/strict';
import test from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  classifyAppleRevocationFailure,
  recoveryBatchLimit,
  recoveryRetryAt,
  recoveryRetryDelayMs,
  shouldTerminalizeAppleRevocation,
} from './recovery-policy.js';
import {
  AppleCredentialError,
  AppleServerError,
} from './apple-server.js';
import {
  buildClaimAccountDeletionBatchQuery,
  buildClaimAppleCredentialBatchQuery,
} from './recovery-queries.js';

test('recovery backoff grows, caps, and keeps batches bounded', () => {
  assert.equal(recoveryRetryDelayMs(1), 30_000);
  assert.equal(recoveryRetryDelayMs(2), 60_000);
  assert.equal(recoveryRetryDelayMs(99), 6 * 60 * 60 * 1_000);
  assert.equal(recoveryBatchLimit(0), 1);
  assert.equal(recoveryBatchLimit(5_000), 500);
  assert.equal(
    recoveryRetryAt(2, new Date('2026-09-19T12:00:00Z')).toISOString(),
    '2026-09-19T12:01:00.000Z'
  );
});

test('Apple revocation has a durable terminal/manual boundary', () => {
  const now = new Date('2026-09-19T12:00:00Z');
  const recent = new Date('2026-09-19T11:00:00Z');
  assert.equal(
    shouldTerminalizeAppleRevocation({
      failureClass: 'permanent',
      attemptCount: 1,
      revocationStartedAt: recent,
      now,
    }),
    true
  );
  assert.equal(
    shouldTerminalizeAppleRevocation({
      failureClass: 'transient',
      attemptCount: 11,
      revocationStartedAt: recent,
      now,
    }),
    false
  );
  assert.equal(
    shouldTerminalizeAppleRevocation({
      failureClass: 'transient',
      attemptCount: 12,
      revocationStartedAt: recent,
      now,
    }),
    true
  );
});

test('Apple revocation distinguishes permanent local/rejected failures', () => {
  assert.equal(
    classifyAppleRevocationFailure(
      new AppleCredentialError('encryption key unavailable')
    ),
    'permanent'
  );
  assert.equal(
    classifyAppleRevocationFailure(
      new AppleServerError('rejected', 400, 'invalid_token')
    ),
    'permanent'
  );
  assert.equal(
    classifyAppleRevocationFailure(
      new AppleServerError('rejected', 401, 'invalid_client')
    ),
    'configuration'
  );
  assert.equal(
    classifyAppleRevocationFailure(new AppleServerError('network', 503)),
    'transient'
  );
  assert.equal(
    shouldTerminalizeAppleRevocation({
      failureClass: 'configuration',
      attemptCount: 1_000,
      revocationStartedAt: new Date('2020-01-01T00:00:00Z'),
      now: new Date('2026-09-19T12:00:00Z'),
    }),
    false
  );
  assert.equal(
    classifyAppleRevocationFailure(
      new AppleServerError('invalid_response', 200)
    ),
    'transient'
  );
});

test('deletion recovery claims a fair ordered batch with skip-locked leases', () => {
  const now = new Date('2026-09-19T12:00:00Z');
  const query = new PgDialect().sqlToQuery(
    buildClaimAccountDeletionBatchQuery({
      owner: 'worker-a',
      now,
      leaseUntil: new Date(now.getTime() + 60_000),
      limit: 100,
    })
  );
  const normalized = query.sql.replace(/\s+/g, ' ').trim();
  assert.match(normalized, /next_attempt_at" asc nulls first/);
  assert.match(normalized, /lease_until" is null/);
  assert.match(normalized, /for update skip locked/);
  assert.match(normalized, /deletion_attempt_count \+ 1/);
});

test('credential recovery atomically claims retryable rows in fair order', () => {
  const now = new Date('2026-09-19T12:00:00Z');
  const query = new PgDialect().sqlToQuery(
    buildClaimAppleCredentialBatchQuery({
      owner: 'worker-b',
      now,
      leaseUntil: new Date(now.getTime() + 60_000),
      limit: 100,
    })
  );
  const normalized = query.sql.replace(/\s+/g, ' ').trim();
  assert.match(normalized, /status" in \('orphaned', 'pending_login'\)/);
  assert.match(normalized, /next_attempt_at" asc nulls first/);
  assert.match(normalized, /for update skip locked/);
  assert.match(normalized, /attempt_count \+ 1/);
  assert.match(normalized, /revocation_started_at = coalesce/);
});
