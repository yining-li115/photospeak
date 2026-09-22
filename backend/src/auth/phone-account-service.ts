import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { AccountDeletionInProgressError } from './session-service.js';

export const PHONE_ACCOUNT_RECOVERY_MS = 7 * 24 * 60 * 60 * 1_000;

export function isPhoneAccountRestoreEligible(input: {
  deletedAt: Date;
  now: Date;
  recoveryMs?: number;
}): boolean {
  const cutoff =
    input.now.getTime() - (input.recoveryMs ?? PHONE_ACCOUNT_RECOVERY_MS);
  return (
    input.deletedAt.getTime() >= cutoff &&
    input.deletedAt.getTime() < input.now.getTime()
  );
}

/** Query shared with a structural concurrency test. */
export function buildPhoneAccountLockQuery(input: {
  phone: string;
  cutoff: Date;
  now: Date;
}) {
  return sql<{ id: string }>`
    select ${schema.users.id}
    from ${schema.users}
    where ${schema.users.phone} = ${input.phone}
      and (
        ${schema.users.deletedAt} is null
        or (
          ${schema.users.deletedAt} >= ${input.cutoff}
          and ${schema.users.deletedAt} < ${input.now}
        )
      )
    order by ${schema.users.deletedAt} desc nulls first, ${schema.users.id}
    for update
  `;
}

/**
 * Return the active account, atomically restore a still-retained account, or
 * create a new one. The row lock coordinates with the hard-delete CTE: either
 * restoration wins and purge skips the row, or purge wins and this creates a
 * clean account after observing that the old row is gone.
 */
export async function findOrCreatePhoneUser(input: {
  phone: string;
  nickname: string;
  now?: Date;
}): Promise<typeof schema.users.$inferSelect> {
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - PHONE_ACCOUNT_RECOVERY_MS);
  return db.transaction(async (tx) => {
    // Serialize same-phone creates/restores without holding a global lock.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`photospeak:phone:${input.phone}`}, 0))`
    );
    const locked = await tx.execute<{ id: string }>(
      buildPhoneAccountLockQuery({ phone: input.phone, cutoff, now })
    );
    const candidateId = locked.rows[0]?.id;
    if (candidateId) {
      let [user] = await tx
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, candidateId))
        .limit(1);
      if (
        user?.deletionState === 'deleting' ||
        (user?.appleLoginReservationId &&
          user.appleLoginReservationExpiresAt &&
          user.appleLoginReservationExpiresAt > now)
      ) {
        throw new AccountDeletionInProgressError();
      }
      if (user?.deletedAt === null) {
        if (user.deletionState !== 'active') {
          throw new AccountDeletionInProgressError();
        }
        return user;
      }
      if (
        user?.deletedAt &&
        isPhoneAccountRestoreEligible({ deletedAt: user.deletedAt, now })
      ) {
        [user] = await tx
          .update(schema.users)
          .set({
            deletedAt: null,
            deletionState: 'active',
            deletionStartedAt: null,
            deletionAuthorizedSessionId: null,
            deletionNextAttemptAt: null,
            deletionLeaseOwner: null,
            deletionLeaseUntil: null,
            deletionAttemptCount: 0,
            appleLoginReservationId: null,
            appleLoginReservationExpiresAt: null,
            appleTokenRevokedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.users.id, candidateId),
              isNotNull(schema.users.deletedAt),
              gte(schema.users.deletedAt, cutoff),
              lt(schema.users.deletedAt, now)
            )
          )
          .returning();
        if (user) return user;
      }
    }

    const [created] = await tx
      .insert(schema.users)
      .values({ phone: input.phone, nickname: input.nickname })
      .onConflictDoNothing()
      .returning();
    if (created) return created;

    // Compatibility fallback for a concurrently running pre-migration server.
    const [active] = await tx
      .select()
      .from(schema.users)
      .where(
        and(
          eq(schema.users.phone, input.phone),
          sql`${schema.users.deletedAt} is null`
        )
      )
      .limit(1)
      .for('update');
    if (!active || active.deletionState !== 'active') {
      throw new AccountDeletionInProgressError();
    }
    return active;
  });
}
