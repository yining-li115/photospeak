import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = (name: string) =>
  new URL(`../../drizzle/${name}`, import.meta.url);

test('0004 remains an expand-only rolling-deploy migration', async () => {
  const sql = await readFile(
    migrationUrl('0004_lush_micromacro.sql'),
    'utf8'
  );
  assert.doesNotMatch(sql, /DELETE FROM "refresh_tokens"/i);
  assert.doesNotMatch(sql, /DROP COLUMN.*"revoked"/i);
  assert.match(sql, /ADD COLUMN "session_id" text;/);
  assert.doesNotMatch(sql, /ADD COLUMN "session_id" text NOT NULL/);
});

test('0005 contains reservation, outbox, replay, lease, and retry schema', async () => {
  const sql = await readFile(
    migrationUrl('0005_unusual_spot.sql'),
    'utf8'
  );
  for (const fragment of [
    'CREATE TABLE IF NOT EXISTS "apple_credentials"',
    '"login_reservation_id" text',
    '"activated_at" timestamp with time zone',
    '"status" text DEFAULT \'pending_login\' NOT NULL',
    '"next_attempt_at" timestamp with time zone',
    '"lease_owner" text',
    '"lease_until" timestamp with time zone',
    '"attempt_count" integer DEFAULT 0 NOT NULL',
    '"revocation_started_at" timestamp with time zone',
    '"deletion_next_attempt_at" timestamp with time zone',
    '"deletion_lease_owner" text',
    '"apple_login_reservation_id" text',
    '"apple_login_reservation_expires_at" timestamp with time zone',
    '"apple_credentials_recovery_idx"',
    '"users_deletion_recovery_idx"',
    '"rotation_idempotency_key_hash" text',
    '"rotation_replay_envelope" text',
    '"rotation_replay_expires_at" timestamp with time zone',
  ]) {
    assert.ok(sql.includes(fragment), `missing migration fragment: ${fragment}`);
  }
  assert.doesNotMatch(sql, /dedupe_expires_at/i);
  assert.match(sql, /REFERENCES "public"\."users"\("id"\) ON DELETE cascade/i);
});

test('0006 adds durable AI operations and stable usage operation ids', async () => {
  const sql = await readFile(
    migrationUrl('0006_ai_operations.sql'),
    'utf8'
  );
  for (const fragment of [
    'CREATE TABLE IF NOT EXISTS "ai_operations"',
    '"idempotency_key_hash" text NOT NULL',
    '"idempotency_key_version" text NOT NULL',
    '"dedupe_expires_at" timestamp with time zone',
    '"request_hash" text NOT NULL',
    '"request_hash_key_id" text NOT NULL',
    '"provider_capability" text DEFAULT \'none\' NOT NULL',
    '"lease_until" timestamp with time zone',
    '"response_envelope" text',
    '"response_expires_at" timestamp with time zone',
    '"ai_operations_result_expiry_idx"',
    '"ai_operations_dedupe_expiry_state_idx"',
    '"ai_operations_request_hash_key_idx"',
    'ADD COLUMN "operation_id" text',
    '"ai_usage_events_user_operation_id_idx"',
    '"ai_usage_events_created_at_idx"',
  ]) {
    assert.ok(sql.includes(fragment), `missing migration fragment: ${fragment}`);
  }
});

test('0007 through 0009 add normalized StoreKit ledgers and quota reservations', async () => {
  const base = await readFile(
    migrationUrl('0007_chunky_senator_kelly.sql'),
    'utf8'
  );
  for (const fragment of [
    'CREATE TABLE "app_store_transactions"',
    'CREATE TABLE "app_store_notifications"',
    'CREATE TABLE "subscription_usage_reservations"',
    '"payload_sha256" text NOT NULL',
    '"subscription_usage_user_month_session_capability_idx"',
    'ON DELETE cascade',
  ]) {
    assert.ok(base.includes(fragment), `missing migration fragment: ${fragment}`);
  }
  assert.doesNotMatch(base, /signed_payload|signed_transaction/i);

  const ordering = await readFile(
    migrationUrl('0008_elite_penance.sql'),
    'utf8'
  );
  assert.match(ordering, /ADD COLUMN "store_event_signed_at"/);

  const lifetimeQuotaIdentity = await readFile(
    migrationUrl('0009_greedy_impossible_man.sql'),
    'utf8'
  );
  assert.match(
    lifetimeQuotaIdentity,
    /subscription_usage_user_session_capability_idx/
  );
  assert.doesNotMatch(
    lifetimeQuotaIdentity,
    /CREATE UNIQUE INDEX[^;]+period_month/
  );
});
