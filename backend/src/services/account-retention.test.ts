import assert from 'node:assert/strict';
import test from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@localhost/unused';

test('account deletion cutoff never allows less than seven days', async () => {
  const { accountDeletionCutoff } = await import('./account-retention.js');
  const now = new Date('2026-09-19T12:00:00.000Z');
  assert.equal(
    accountDeletionCutoff(now, 1).toISOString(),
    '2026-09-12T12:00:00.000Z'
  );
});

test('hard deletion locks and rechecks eligibility in one SQL statement', async () => {
  const { buildDeletedAccountPurgeStatement } = await import(
    './account-retention.js'
  );
  const cutoff = new Date('2026-09-12T12:00:00.000Z');
  const query = new PgDialect().sqlToQuery(
    buildDeletedAccountPurgeStatement(cutoff, 250)
  );
  const normalized = query.sql.replace(/\s+/g, ' ').trim();
  assert.match(normalized, /with candidates as \(/);
  assert.match(normalized, /for update skip locked/);
  assert.match(normalized, /delete from "users" as target using candidates/);
  assert.equal(normalized.match(/deleted_at"? is not null/g)?.length, 2);
  assert.equal(query.params.filter((value) => value === cutoff).length, 2);
  assert.equal(
    normalized.match(/apple_login_reservation_id"? is null/g)?.length,
    2
  );
});

test('refresh cleanup retains an idempotent replay until its session expiry', async () => {
  const { buildExpiredRefreshTokenPredicate } = await import(
    './account-retention.js'
  );
  const query = new PgDialect().sqlToQuery(
    buildExpiredRefreshTokenPredicate(
      new Date('2026-09-19T12:00:00Z'),
      new Date('2026-09-12T12:00:00Z')
    )!
  );
  const normalized = query.sql.replace(/\s+/g, ' ').trim();
  assert.match(normalized, /rotation_replay_expires_at"? is null/);
  assert.match(normalized, /rotation_replay_expires_at"? < /);
});

test('AI tombstone cleanup quarantines stale leases and deletes only non-running versioned rows', async () => {
  const {
    aiOperationTombstonePurgeCutoff,
    buildExpiredAiOperationLeaseQuarantineStatement,
    buildExpiredAiOperationTombstonePurgeStatement,
  } = await import('./account-retention.js');
  const now = new Date('2027-09-19T12:00:00.000Z');
  const cutoff = aiOperationTombstonePurgeCutoff(now);
  assert.equal(cutoff.toISOString(), '2027-09-12T12:00:00.000Z');

  const quarantine = new PgDialect().sqlToQuery(
    buildExpiredAiOperationLeaseQuarantineStatement(cutoff, now, 250)
  );
  const quarantineSql = quarantine.sql.replace(/\s+/g, ' ').trim();
  assert.match(quarantineSql, /for update skip locked/);
  assert.match(quarantineSql, /state"? = 'running'/);
  assert.match(quarantineSql, /set state = 'uncertain'/);
  assert.match(quarantineSql, /dedupe_expires_at"? is not null/);

  const purge = new PgDialect().sqlToQuery(
    buildExpiredAiOperationTombstonePurgeStatement(cutoff, 250)
  );
  const purgeSql = purge.sql.replace(/\s+/g, ' ').trim();
  assert.match(purgeSql, /for update skip locked/);
  assert.match(purgeSql, /delete from "ai_operations" as target/);
  assert.equal(purgeSql.match(/state"? <> 'running'/g)?.length, 2);
  assert.equal(
    purgeSql.match(/dedupe_expires_at"? is not null/g)?.length,
    2
  );
});

test('abandoned Apple reservations are durably flagged after a locked recheck', async () => {
  const { buildAbandonedAppleReservationMarkStatement } = await import(
    './account-retention.js'
  );
  const query = new PgDialect().sqlToQuery(
    buildAbandonedAppleReservationMarkStatement(
      new Date('2026-09-19T12:00:00Z'),
      250
    )
  );
  const normalized = query.sql.replace(/\s+/g, ' ').trim();
  assert.match(normalized, /for update skip locked/);
  assert.equal(
    normalized.match(/status"? = 'pending_login'/g)?.length,
    2
  );
  assert.match(normalized, /apple_manual_revoke_required_at = coalesce/);
  assert.match(normalized, /apple_login_reservation_id = null/);
});

test('abandoned Apple provisional PII purge rechecks every ownership guard', async () => {
  const { buildAbandonedAppleProvisioningPurgeStatement } = await import(
    './account-retention.js'
  );
  const cutoff = new Date('2026-09-12T12:00:00Z');
  const query = new PgDialect().sqlToQuery(
    buildAbandonedAppleProvisioningPurgeStatement(cutoff, 250)
  );
  const normalized = query.sql.replace(/\s+/g, ' ').trim();
  assert.match(normalized, /for update skip locked/);
  assert.equal(
    normalized.match(/deletion_state"? = 'provisioning'/g)?.length,
    2
  );
  assert.ok((normalized.match(/auth_sessions/g)?.length ?? 0) >= 2);
  assert.ok((normalized.match(/consent_receipts/g)?.length ?? 0) >= 2);
  assert.ok((normalized.match(/user_entitlements/g)?.length ?? 0) >= 2);
  assert.ok((normalized.match(/encrypted_refresh_token/g)?.length ?? 0) >= 2);
  assert.equal(query.params.filter((value) => value === cutoff).length, 2);
});
