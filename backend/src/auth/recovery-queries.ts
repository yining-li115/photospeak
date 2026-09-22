import { sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { recoveryBatchLimit } from './recovery-policy.js';

export function buildClaimAccountDeletionBatchQuery(input: {
  owner: string;
  now: Date;
  leaseUntil: Date;
  limit?: number;
  userId?: string;
}) {
  const userPredicate = input.userId
    ? sql`and ${schema.users.id} = ${input.userId}`
    : sql``;
  return sql`
    with candidates as (
      select ${schema.users.id}
      from ${schema.users}
      where ${schema.users.deletionState} = 'deleting'
        and ${schema.users.deletedAt} is null
        and (
          ${schema.users.deletionNextAttemptAt} is null
          or ${schema.users.deletionNextAttemptAt} <= ${input.now}
        )
        and (
          ${schema.users.deletionLeaseUntil} is null
          or ${schema.users.deletionLeaseUntil} <= ${input.now}
        )
        ${userPredicate}
      order by ${schema.users.deletionNextAttemptAt} asc nulls first,
        ${schema.users.deletionStartedAt} asc nulls first,
        ${schema.users.id}
      limit ${recoveryBatchLimit(input.limit)}
      for update skip locked
    )
    update ${schema.users} as target
    set deletion_lease_owner = ${input.owner},
      deletion_lease_until = ${input.leaseUntil},
      deletion_attempt_count = target.deletion_attempt_count + 1
    from candidates
    where target.id = candidates.id
    returning target.id as "userId",
      target.deletion_attempt_count as "attemptCount"
  `;
}

export function buildClaimAppleCredentialBatchQuery(input: {
  owner: string;
  now: Date;
  leaseUntil: Date;
  limit?: number;
  userId?: string;
}) {
  const scopePredicate = input.userId
    ? sql`and ${schema.appleCredentials.userId} = ${input.userId}
        and ${schema.appleCredentials.status} in ('active', 'pending_login')`
    : sql`and ${schema.appleCredentials.status} in ('orphaned', 'pending_login')
        and (
          ${schema.appleCredentials.nextAttemptAt} is null
          or ${schema.appleCredentials.nextAttemptAt} <= ${input.now}
        )`;
  return sql`
    with candidates as (
      select ${schema.appleCredentials.id}
      from ${schema.appleCredentials}
      where (
          ${schema.appleCredentials.leaseUntil} is null
          or ${schema.appleCredentials.leaseUntil} <= ${input.now}
        )
        ${scopePredicate}
      order by ${schema.appleCredentials.nextAttemptAt} asc nulls first,
        ${schema.appleCredentials.lastRevocationAttemptAt} asc nulls first,
        ${schema.appleCredentials.createdAt},
        ${schema.appleCredentials.id}
      limit ${recoveryBatchLimit(input.limit)}
      for update skip locked
    )
    update ${schema.appleCredentials} as target
    set lease_owner = ${input.owner},
      lease_until = ${input.leaseUntil},
      attempt_count = target.attempt_count + 1,
      revocation_started_at = coalesce(
        target.revocation_started_at,
        ${input.now}
      )
    from candidates
    where target.id = candidates.id
    returning target.id,
      target.user_id as "userId",
      target.apple_user_id as "appleUserId",
      target.encrypted_refresh_token as "encryptedRefreshToken",
      target.encryption_key_id as "encryptionKeyId",
      target.status,
      target.login_reservation_id as "loginReservationId",
      target.attempt_count as "attemptCount",
      target.revocation_started_at as "revocationStartedAt"
  `;
}
