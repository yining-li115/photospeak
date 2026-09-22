import { and, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { AI_IDEMPOTENCY_TOMBSTONE_CLEANUP_MARGIN_MS } from '../ai/idempotency-key.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

export function accountDeletionCutoff(
  now = new Date(),
  retentionDays = 7
): Date {
  const safeDays = Math.max(7, Math.floor(retentionDays));
  return new Date(now.getTime() - safeDays * DAY_MS);
}

/**
 * Permanently remove accounts whose recovery window elapsed. Every server-side
 * user-owned table must reference users(id) with ON DELETE CASCADE; future
 * object-storage cleanup should be added here before introducing cloud media.
 */
export async function purgeDeletedAccounts(options?: {
  now?: Date;
  retentionDays?: number;
  limit?: number;
}): Promise<number> {
  const now = options?.now ?? new Date();
  const cutoff = accountDeletionCutoff(
    now,
    options?.retentionDays ?? 7
  );
  const limit = batchLimit(options?.limit);
  // Keep selection, eligibility re-check, and deletion in one statement.
  // A concurrent login either owns the row first (SKIP LOCKED leaves it
  // alone) or waits for this statement, so a just-reactivated account cannot
  // be deleted using an id captured by a stale earlier SELECT.
  const result = await db.execute<{ id: string }>(
    buildDeletedAccountPurgeStatement(cutoff, limit, now)
  );
  return result.rows.length;
}

/** Remove sensitive cached AI output while keeping a dedupe tombstone. */
export async function expireAiOperationResults(options?: {
  now?: Date;
  limit?: number;
}): Promise<number> {
  const now = options?.now ?? new Date();
  const result = await db.execute<{ id: string }>(sql`
    with candidates as (
      select ${schema.aiOperations.id}
      from ${schema.aiOperations}
      where ${schema.aiOperations.state} in (
        'succeeded', 'rejected', 'failed_final'
      )
        and ${schema.aiOperations.responseExpiresAt} <= ${now}
      order by ${schema.aiOperations.responseExpiresAt}, ${schema.aiOperations.id}
      limit ${batchLimit(options?.limit)}
      for update skip locked
    )
    update ${schema.aiOperations} as target
    set state = 'result_expired',
        response_envelope = null,
        updated_at = ${now}
    from candidates
    where target.id = candidates.id
      and target.state in ('succeeded', 'rejected', 'failed_final')
      and target.response_expires_at <= ${now}
    returning target.id
  `);
  return result.rows.length;
}

export function aiOperationTombstonePurgeCutoff(now = new Date()): Date {
  return new Date(
    now.getTime() - AI_IDEMPOTENCY_TOMBSTONE_CLEANUP_MARGIN_MS
  );
}

/**
 * A process cannot legitimately hold a 400-day-old lease. Quarantine it first
 * so the tombstone purge itself only ever deletes non-running operations.
 */
export async function quarantineExpiredAiOperationLeases(options?: {
  now?: Date;
  limit?: number;
}): Promise<number> {
  const now = options?.now ?? new Date();
  const result = await db.execute<{ id: string }>(
    buildExpiredAiOperationLeaseQuarantineStatement(
      aiOperationTombstonePurgeCutoff(now),
      now,
      batchLimit(options?.limit)
    )
  );
  return result.rows.length;
}

export function buildExpiredAiOperationLeaseQuarantineStatement(
  cutoff: Date,
  now: Date,
  limit: number
) {
  return sql`
    with candidates as (
      select ${schema.aiOperations.id}
      from ${schema.aiOperations}
      where ${schema.aiOperations.dedupeExpiresAt} is not null
        and ${schema.aiOperations.dedupeExpiresAt} <= ${cutoff}
        and ${schema.aiOperations.state} = 'running'
        and (
          ${schema.aiOperations.leaseUntil} is null
          or ${schema.aiOperations.leaseUntil} <= ${now}
        )
      order by ${schema.aiOperations.dedupeExpiresAt}, ${schema.aiOperations.id}
      limit ${limit}
      for update skip locked
    )
    update ${schema.aiOperations} as target
    set state = 'uncertain',
        error_code = coalesce(target.error_code, 'expired_key_stale_lease'),
        lease_owner = null,
        lease_until = null,
        updated_at = ${now}
    from candidates
    where target.id = candidates.id
      and target.state = 'running'
      and target.dedupe_expires_at <= ${cutoff}
      and (target.lease_until is null or target.lease_until <= ${now})
    returning target.id
  `;
}

/**
 * Delete only versioned-key tombstones after their rejection horizon plus a
 * safety margin. Legacy UUID rows have a NULL expiry and remain until account
 * deletion, preserving offline beta intents and backups.
 */
export async function purgeExpiredAiOperationTombstones(options?: {
  now?: Date;
  limit?: number;
}): Promise<number> {
  const now = options?.now ?? new Date();
  const result = await db.execute<{ id: string }>(
    buildExpiredAiOperationTombstonePurgeStatement(
      aiOperationTombstonePurgeCutoff(now),
      batchLimit(options?.limit)
    )
  );
  return result.rows.length;
}

export function buildExpiredAiOperationTombstonePurgeStatement(
  cutoff: Date,
  limit: number
) {
  return sql`
    with candidates as (
      select ${schema.aiOperations.id}
      from ${schema.aiOperations}
      where ${schema.aiOperations.dedupeExpiresAt} is not null
        and ${schema.aiOperations.dedupeExpiresAt} <= ${cutoff}
        and ${schema.aiOperations.state} <> 'running'
      order by ${schema.aiOperations.dedupeExpiresAt}, ${schema.aiOperations.id}
      limit ${limit}
      for update skip locked
    )
    delete from ${schema.aiOperations} as target
    using candidates
    where target.id = candidates.id
      and target.dedupe_expires_at is not null
      and target.dedupe_expires_at <= ${cutoff}
      and target.state <> 'running'
    returning target.id
  `;
}

/** Exported for a structural unit test; production calls it via the function above. */
export function buildDeletedAccountPurgeStatement(
  cutoff: Date,
  limit: number,
  now = new Date()
) {
  return sql`
    with candidates as (
      select ${schema.users.id}
      from ${schema.users}
      where ${schema.users.deletedAt} is not null
        and ${schema.users.deletedAt} < ${cutoff}
        and (
          ${schema.users.appleLoginReservationId} is null
          or ${schema.users.appleLoginReservationExpiresAt} <= ${now}
        )
      order by ${schema.users.deletedAt}, ${schema.users.id}
      limit ${limit}
      for update skip locked
    )
    delete from ${schema.users} as target
    using candidates
    where target.id = candidates.id
      and target.deleted_at is not null
      and target.deleted_at < ${cutoff}
      and (
        target.apple_login_reservation_id is null
        or target.apple_login_reservation_expires_at <= ${now}
      )
    returning target.id
  `;
}

/** Flag the irreducible exchange-to-persistence crash gap for manual revoke. */
export async function markAbandonedAppleLoginReservations(options?: {
  now?: Date;
  limit?: number;
}): Promise<number> {
  const now = options?.now ?? new Date();
  const result = await db.execute<{ id: string }>(
    buildAbandonedAppleReservationMarkStatement(
      now,
      batchLimit(options?.limit)
    )
  );
  return result.rows.length;
}

export function buildAbandonedAppleReservationMarkStatement(
  now: Date,
  limit: number
) {
  return sql`
    with candidates as (
      select ${schema.users.id}
      from ${schema.users}
      where ${schema.users.appleLoginReservationId} is not null
        and ${schema.users.appleLoginReservationExpiresAt} < ${now}
        and not exists (
          select 1 from ${schema.appleCredentials}
          where ${schema.appleCredentials.userId} = ${schema.users.id}
            and ${schema.appleCredentials.status} = 'pending_login'
            and ${schema.appleCredentials.loginReservationId} =
              ${schema.users.appleLoginReservationId}
        )
      order by ${schema.users.appleLoginReservationExpiresAt}, ${schema.users.id}
      limit ${limit}
      for update skip locked
    )
    update ${schema.users} as target
    set apple_manual_revoke_required_at = coalesce(
        target.apple_manual_revoke_required_at,
        ${now}
      ),
      apple_login_reservation_id = null,
      apple_login_reservation_expires_at = null,
      updated_at = ${now}
    from candidates
    where target.id = candidates.id
      and target.apple_login_reservation_id is not null
      and target.apple_login_reservation_expires_at < ${now}
      and not exists (
        select 1 from ${schema.appleCredentials} as credential
        where credential.user_id = target.id
          and credential.status = 'pending_login'
          and credential.login_reservation_id =
            target.apple_login_reservation_id
      )
    returning target.id
  `;
}

/** Remove PII placeholders that never completed registration. */
export async function purgeAbandonedAppleProvisioningUsers(options?: {
  now?: Date;
  retentionDays?: number;
  limit?: number;
}): Promise<number> {
  const now = options?.now ?? new Date();
  const cutoff = new Date(
    now.getTime() -
      Math.max(1, Math.floor(options?.retentionDays ?? 7)) * DAY_MS
  );
  const result = await db.execute<{ id: string }>(
    buildAbandonedAppleProvisioningPurgeStatement(
      cutoff,
      batchLimit(options?.limit)
    )
  );
  return result.rows.length;
}

export function buildAbandonedAppleProvisioningPurgeStatement(
  cutoff: Date,
  limit: number
) {
  return sql`
    with candidates as (
      select ${schema.users.id}
      from ${schema.users}
      where ${schema.users.deletionState} = 'provisioning'
        and ${schema.users.deletedAt} is null
        and ${schema.users.appleLoginReservationId} is null
        and ${schema.users.updatedAt} < ${cutoff}
        and not exists (
          select 1 from ${schema.authSessions}
          where ${schema.authSessions.userId} = ${schema.users.id}
        )
        and not exists (
          select 1 from ${schema.consentReceipts}
          where ${schema.consentReceipts.userId} = ${schema.users.id}
        )
        and not exists (
          select 1 from ${schema.userEntitlements}
          where ${schema.userEntitlements.userId} = ${schema.users.id}
        )
        and not exists (
          select 1 from ${schema.appleCredentials}
          where ${schema.appleCredentials.userId} = ${schema.users.id}
            and ${schema.appleCredentials.encryptedRefreshToken} is not null
        )
      order by ${schema.users.updatedAt}, ${schema.users.id}
      limit ${limit}
      for update skip locked
    )
    delete from ${schema.users} as target
    using candidates
    where target.id = candidates.id
      and target.deletion_state = 'provisioning'
      and target.deleted_at is null
      and target.apple_login_reservation_id is null
      and target.updated_at < ${cutoff}
      and not exists (
        select 1 from ${schema.authSessions} as session
        where session.user_id = target.id
      )
      and not exists (
        select 1 from ${schema.consentReceipts} as consent
        where consent.user_id = target.id
      )
      and not exists (
        select 1 from ${schema.userEntitlements} as entitlement
        where entitlement.user_id = target.id
      )
      and not exists (
        select 1 from ${schema.appleCredentials} as credential
        where credential.user_id = target.id
          and credential.encrypted_refresh_token is not null
      )
    returning target.id
  `;
}

/** Prevent one-time refresh-token rotation rows from growing forever. */
export async function purgeExpiredRefreshTokens(options?: {
  now?: Date;
  revokedRetentionDays?: number;
  limit?: number;
}): Promise<number> {
  const now = options?.now ?? new Date();
  const revokedCutoff = new Date(
    now.getTime() -
      Math.max(1, Math.floor(options?.revokedRetentionDays ?? 7)) * DAY_MS
  );
  const predicate = buildExpiredRefreshTokenPredicate(now, revokedCutoff);
  const candidates = await db
    .select({ tokenHash: schema.refreshTokens.tokenHash })
    .from(schema.refreshTokens)
    .where(predicate)
    .limit(batchLimit(options?.limit));
  if (candidates.length === 0) return 0;
  const deleted = await db
    .delete(schema.refreshTokens)
    .where(
      inArray(
        schema.refreshTokens.tokenHash,
        candidates.map((row) => row.tokenHash)
      )
    )
    .returning({ tokenHash: schema.refreshTokens.tokenHash });
  return deleted.length;
}

export function buildExpiredRefreshTokenPredicate(
  now: Date,
  revokedCutoff: Date
) {
  return or(
    lt(schema.refreshTokens.expiresAt, now),
    and(
      isNotNull(schema.refreshTokens.revokedAt),
      lt(schema.refreshTokens.revokedAt, revokedCutoff),
      or(
        isNull(schema.refreshTokens.rotationReplayExpiresAt),
        lt(schema.refreshTokens.rotationReplayExpiresAt, now)
      )
    )
  );
}

/** Delete ended session families; refresh rows cascade with the session. */
export async function purgeExpiredAuthSessions(options?: {
  now?: Date;
  revokedRetentionDays?: number;
  limit?: number;
}): Promise<number> {
  const now = options?.now ?? new Date();
  const revokedCutoff = new Date(
    now.getTime() -
      Math.max(1, Math.floor(options?.revokedRetentionDays ?? 7)) * DAY_MS
  );
  const predicate = or(
    lt(schema.authSessions.expiresAt, now),
    and(
      isNotNull(schema.authSessions.revokedAt),
      lt(schema.authSessions.revokedAt, revokedCutoff)
    )
  );
  const candidates = await db
    .select({ id: schema.authSessions.id })
    .from(schema.authSessions)
    .where(predicate)
    .limit(batchLimit(options?.limit));
  if (candidates.length === 0) return 0;
  const deleted = await db
    .delete(schema.authSessions)
    .where(inArray(schema.authSessions.id, candidates.map((row) => row.id)))
    .returning({ id: schema.authSessions.id });
  return deleted.length;
}

/** Keep detailed request rows bounded; export aggregates before this horizon. */
export async function purgeOldUsageEvents(options?: {
  now?: Date;
  retentionDays?: number;
  limit?: number;
}): Promise<number> {
  const now = options?.now ?? new Date();
  const retentionDays = Math.max(
    90,
    Math.floor(options?.retentionDays ?? 400)
  );
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const candidates = await db
    .select({ id: schema.aiUsageEvents.id })
    .from(schema.aiUsageEvents)
    .where(lt(schema.aiUsageEvents.createdAt, cutoff))
    .orderBy(schema.aiUsageEvents.createdAt, schema.aiUsageEvents.id)
    .limit(batchLimit(options?.limit));
  if (candidates.length === 0) return 0;
  const deleted = await db
    .delete(schema.aiUsageEvents)
    .where(inArray(schema.aiUsageEvents.id, candidates.map((row) => row.id)))
    .returning({ id: schema.aiUsageEvents.id });
  return deleted.length;
}

function batchLimit(value = 250): number {
  if (!Number.isFinite(value)) return 250;
  return Math.max(1, Math.min(1_000, Math.floor(value)));
}
