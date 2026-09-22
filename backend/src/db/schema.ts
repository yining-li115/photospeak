import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * One row per registered user. A user can sign in with Apple or with a
 * phone number; the row is the same — apple_user_id and phone are
 * independently nullable. Account deletion is soft (deleted_at set);
 * a daily job hard-deletes after a 7-day cooldown.
 */
export const users = pgTable(
  'users',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    appleUserId: text('apple_user_id').unique(),
    deletionState: text('deletion_state').notNull().default('active'),
    deletionStartedAt: timestamp('deletion_started_at', {
      withTimezone: true,
    }),
    deletionAuthorizedSessionId: text('deletion_authorized_session_id'),
    deletionNextAttemptAt: timestamp('deletion_next_attempt_at', {
      withTimezone: true,
    }),
    deletionLeaseOwner: text('deletion_lease_owner'),
    deletionLeaseUntil: timestamp('deletion_lease_until', {
      withTimezone: true,
    }),
    deletionAttemptCount: integer('deletion_attempt_count')
      .notNull()
      .default(0),
    appleLoginReservationId: text('apple_login_reservation_id'),
    appleLoginReservationExpiresAt: timestamp(
      'apple_login_reservation_expires_at',
      { withTimezone: true }
    ),
    appleTokenRevokedAt: timestamp('apple_token_revoked_at', {
      withTimezone: true,
    }),
    appleManualRevokeRequiredAt: timestamp(
      'apple_manual_revoke_required_at',
      { withTimezone: true }
    ),
    phone: text('phone'),
    email: text('email'),
    nickname: text('nickname').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    // Phone is unique only for active (non-deleted) users so a deleted
    // account doesn't permanently squat the number.
    phoneActiveIdx: uniqueIndex('users_phone_active_idx')
      .on(t.phone)
      .where(sql`${t.deletedAt} IS NULL AND ${t.phone} IS NOT NULL`),
    deletionRecoveryIdx: index('users_deletion_recovery_idx').on(
      t.deletionState,
      t.deletionNextAttemptAt,
      t.deletionLeaseUntil
    ),
  })
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/**
 * One row per Apple refresh token ever issued to the server. Keeping tokens
 * independently prevents a later login from overwriting a still-valid older
 * credential. Ciphertext is AES-256-GCM and bound to apple_user_id as AAD.
 */
export const appleCredentials = pgTable(
  'apple_credentials',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    // Null only for a compensation/outbox credential when an Apple exchange
    // succeeded but the surrounding login transaction could not commit.
    userId: text('user_id').references(() => users.id, {
      onDelete: 'cascade',
    }),
    appleUserId: text('apple_user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    encryptedRefreshToken: text('encrypted_refresh_token'),
    encryptionKeyId: text('encryption_key_id').notNull(),
    status: text('status').notNull().default('pending_login'),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    loginReservationId: text('login_reservation_id'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    leaseOwner: text('lease_owner'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    attemptCount: integer('attempt_count').notNull().default(0),
    revocationStartedAt: timestamp('revocation_started_at', {
      withTimezone: true,
    }),
    lastRevocationAttemptAt: timestamp('last_revocation_attempt_at', {
      withTimezone: true,
    }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tokenHashIdx: uniqueIndex('apple_credentials_token_hash_idx').on(
      t.tokenHash
    ),
    userStatusIdx: index('apple_credentials_user_status_idx').on(
      t.userId,
      t.status
    ),
    recoveryIdx: index('apple_credentials_recovery_idx').on(
      t.status,
      t.nextAttemptAt,
      t.leaseUntil
    ),
  })
);

export type AppleCredential = typeof appleCredentials.$inferSelect;

/**
 * Subscription entitlement is independent from identity so App Store,
 * Play Billing, and promotional grants can converge on one server-owned
 * access decision later.
 */
export const userEntitlements = pgTable(
  'user_entitlements',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    plan: text('plan').notNull().default('free'),
    status: text('status').notNull().default('active'),
    source: text('source').notNull().default('system'),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    planStatusIdx: index('user_entitlements_plan_status_idx').on(
      t.plan,
      t.status
    ),
  })
);

/** Append-only proof of which legal/privacy text a user accepted. */
export const consentReceipts = pgTable(
  'consent_receipts',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    consentVersion: text('consent_version').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
    source: text('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userVersionIdx: uniqueIndex('consent_receipts_user_version_idx').on(
      t.userId,
      t.consentVersion
    ),
  })
);

/** One revocable login session and refresh-token family per sign-in. */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    authenticatedAt: timestamp('authenticated_at', { withTimezone: true })
      .notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revocationReason: text('revocation_reason'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdx: index('auth_sessions_user_idx').on(t.userId),
    expiryIdx: index('auth_sessions_expiry_idx').on(t.expiresAt),
  })
);

export type AuthSession = typeof authSessions.$inferSelect;

/** One-time refresh credentials belonging to a revocable session family. */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    // Keep the historical SQL column name for a non-destructive schema
    // migration; only SHA-256 hashes are stored after migration 0004.
    tokenHash: text('token').primaryKey(),
    sessionId: text('session_id')
      .references(() => authSessions.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    parentTokenHash: text('parent_token_hash'),
    replacedByTokenHash: text('replaced_by_token_hash'),
    rotationIdempotencyKeyHash: text('rotation_idempotency_key_hash'),
    rotationReplayEnvelope: text('rotation_replay_envelope'),
    rotationReplayExpiresAt: timestamp('rotation_replay_expires_at', {
      withTimezone: true,
    }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revocationReason: text('revocation_reason'),
    // Kept through the expand phase so a previously deployed process can
    // continue reading/writing the table during a rolling restart. New code
    // uses revoked_at and deliberately ignores this compatibility column.
    legacyRevoked: boolean('revoked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdx: index('refresh_tokens_user_idx').on(t.userId),
    sessionIdx: index('refresh_tokens_session_idx').on(t.sessionId),
  })
);

export type RefreshToken = typeof refreshTokens.$inferSelect;

/**
 * Provider-neutral usage ledger. It intentionally stores no prompt, image,
 * transcript, or generated content: only operational and billing metadata.
 * This supports cost monitoring and abuse controls without creating another
 * copy of sensitive user data.
 */
export const aiUsageEvents = pgTable(
  'ai_usage_events',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    requestId: text('request_id').notNull(),
    /** Stable logical operation id. Transport request ids change on replay. */
    operationId: text('operation_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    capability: text('capability').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    status: text('status').notNull(),
    plan: text('plan').notNull().default('free'),
    inputUnits: integer('input_units'),
    outputUnits: integer('output_units'),
    estimatedCostMicros: integer('estimated_cost_micros'),
    billingCurrency: text('billing_currency'),
    latencyMs: integer('latency_ms').notNull(),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userRequestIdIdx: uniqueIndex('ai_usage_events_user_request_id_idx').on(
      t.userId,
      t.requestId
    ),
    userOperationIdIdx: uniqueIndex(
      'ai_usage_events_user_operation_id_idx'
    ).on(t.userId, t.operationId),
    userCreatedIdx: index('ai_usage_events_user_created_idx').on(
      t.userId,
      t.createdAt
    ),
    capabilityCreatedIdx: index('ai_usage_events_capability_created_idx').on(
      t.capability,
      t.createdAt
    ),
    createdAtIdx: index('ai_usage_events_created_at_idx').on(
      t.createdAt,
      t.id
    ),
  })
);

export type AiUsageEvent = typeof aiUsageEvents.$inferSelect;

/**
 * Durable boundary around one billable AI operation. The request body is
 * deliberately never stored: only a random-key digest, keyed payload hash,
 * operational metadata and a short-lived AES-GCM result envelope live here.
 */
export const aiOperations = pgTable(
  'ai_operations',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    capability: text('capability').notNull(),
    idempotencyKeyHash: text('idempotency_key_hash').notNull(),
    idempotencyKeyVersion: text('idempotency_key_version').notNull(),
    dedupeExpiresAt: timestamp('dedupe_expires_at', { withTimezone: true }),
    requestHash: text('request_hash').notNull(),
    requestHashKeyId: text('request_hash_key_id').notNull(),
    contractVersion: integer('contract_version').notNull().default(1),
    executionFingerprint: text('execution_fingerprint').notNull(),
    state: text('state').notNull().default('pending'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    providerCapability: text('provider_capability').notNull().default('none'),
    providerIdempotencyKey: text('provider_idempotency_key').notNull(),
    providerRequestId: text('provider_request_id'),
    attemptCount: integer('attempt_count').notNull().default(0),
    leaseOwner: text('lease_owner'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    responseStatus: integer('response_status'),
    responseEnvelope: text('response_envelope'),
    errorCode: text('error_code'),
    responseExpiresAt: timestamp('response_expires_at', {
      withTimezone: true,
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    userKeyIdx: uniqueIndex('ai_operations_user_capability_key_idx').on(
      t.userId,
      t.capability,
      t.idempotencyKeyHash
    ),
    leaseIdx: index('ai_operations_state_lease_idx').on(
      t.state,
      t.leaseUntil
    ),
    resultExpiryIdx: index('ai_operations_result_expiry_idx').on(
      t.responseExpiresAt
    ),
    dedupeExpiryIdx: index('ai_operations_dedupe_expiry_state_idx').on(
      t.dedupeExpiresAt,
      t.state
    ),
    requestHashKeyIdx: index('ai_operations_request_hash_key_idx').on(
      t.requestHashKeyId
    ),
  })
);

export type AiOperation = typeof aiOperations.$inferSelect;
