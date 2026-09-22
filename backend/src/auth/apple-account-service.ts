import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import type { AppleIdentity } from './apple.js';
import { verifyAppleIdentityToken } from './apple.js';
import { compensateAppleCredential } from './apple-compensation.js';
import {
  isAppleLoginReservationCurrent,
  type AppleLoginReservationMode,
} from './apple-login-reservation-policy.js';
import {
  AppleIdentityMismatchError,
  assertSameAppleSubject,
  hashAppleRefreshToken,
  type AppleServerTokenGateway,
} from './apple-server.js';
import {
  hashRefreshToken,
  issueAccessToken,
  issueRefreshToken,
} from './jwt.js';
import { AccountDeletionInProgressError } from './session-service.js';

const DELETE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1_000;
const LOGIN_RESERVATION_MS = 2 * 60 * 1_000;

interface AppleLoginReservation {
  id: string;
  userId: string;
  mode: AppleLoginReservationMode;
  expiresAt: Date;
}

export class AppleLoginCompensationError extends Error {
  constructor(
    readonly originalError: unknown,
    readonly cleanupQueued: boolean
  ) {
    super('Apple login failed and the issued credential could not be revoked');
    this.name = 'AppleLoginCompensationError';
  }
}

class AppleLoginReservationError extends Error {
  constructor() {
    super('Apple login reservation is no longer current');
    this.name = 'AppleLoginReservationError';
  }
}

export interface AppleLoginInput {
  identity: AppleIdentity;
  authorizationCode: string;
  fullName?: { givenName?: string; familyName?: string } | null;
  consent: { version: string; acceptedAt: Date; source: string };
  appleServer: AppleServerTokenGateway;
}

export interface AppleLoginResult {
  accessToken: string;
  refreshToken: string;
  user: typeof schema.users.$inferSelect;
}

/**
 * Apple network I/O deliberately happens outside PostgreSQL transactions.
 * Short reservation/CAS transactions give account deletion precedence: it
 * clears the reservation before revocation, so a late login can only revoke or
 * enqueue its newly issued Apple credential, never reactivate behind deletion.
 */
export async function completeAppleLogin(
  input: AppleLoginInput
): Promise<AppleLoginResult> {
  const reservation = await reserveAppleLogin(input);
  let credentialToCompensate: string | undefined;
  let compensationEnvelope: string | undefined;
  let compensationTokenHash: string | undefined;
  let pendingCredentialId: string | undefined;
  let compensationRequired = false;

  try {
    // No DB transaction or connection is held across either Apple call/JWKS.
    const exchange = await input.appleServer.exchangeAuthorizationCode(
      input.authorizationCode
    );
    credentialToCompensate = exchange.refreshToken;
    compensationRequired = true;
    compensationEnvelope = input.appleServer.sealRefreshToken(
      exchange.refreshToken,
      input.identity.sub
    );
    compensationTokenHash = hashAppleRefreshToken(exchange.refreshToken);

    const persisted = await persistPendingAppleCredential({
      reservation,
      appleUserId: input.identity.sub,
      tokenHash: compensationTokenHash,
      encryptedRefreshToken: compensationEnvelope,
      encryptionKeyId: input.appleServer.encryptionKeyId,
    });
    pendingCredentialId = persisted.credentialId;
    if (persisted.alreadyActive) compensationRequired = false;

    const exchangedIdentity = await verifyAppleIdentityToken(
      exchange.idToken,
      input.appleServer.clientId
    );
    assertSameAppleSubject(input.identity.sub, exchangedIdentity.sub);

    const result = await finalizeAppleLogin({
      reservation,
      pendingCredentialId,
      input,
    });
    compensationRequired = false;
    return result;
  } catch (error) {
    if (credentialToCompensate && compensationRequired) {
      const refreshToken = credentialToCompensate;
      const envelope = compensationEnvelope;
      const tokenHash = compensationTokenHash;
      const compensation = await compensateAppleCredential({
        revoke: () => input.appleServer.revokeRefreshToken(refreshToken),
        enqueue:
          envelope && tokenHash
            ? () =>
                enqueueFailedAppleLoginCompensation({
                  reservation,
                  appleUserId: input.identity.sub,
                  tokenHash,
                  encryptedRefreshToken: envelope,
                  encryptionKeyId: input.appleServer.encryptionKeyId,
                })
            : undefined,
      });
      if (compensation === 'revoked') {
        await finishFailedAppleLogin({
          reservation,
          pendingCredentialId,
          revoked: true,
        }).catch(() => {});
      } else {
        throw new AppleLoginCompensationError(
          error,
          compensation === 'queued'
        );
      }
    } else {
      await finishFailedAppleLogin({
        reservation,
        pendingCredentialId,
        revoked: false,
      }).catch(() => {});
    }
    if (error instanceof AppleIdentityMismatchError) throw error;
    throw error;
  }
}

async function reserveAppleLogin(
  input: AppleLoginInput
): Promise<AppleLoginReservation> {
  const now = new Date();
  const reservationId = randomUUID();
  const expiresAt = new Date(now.getTime() + LOGIN_RESERVATION_MS);

  return db.transaction(async (tx): Promise<AppleLoginReservation> => {
    // This lock serializes only a short mutation and is released pre-network.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`photospeak:apple:${input.identity.sub}`}, 0))`
    );
    let user: typeof schema.users.$inferSelect | undefined;
    [user] = await tx
      .select()
      .from(schema.users)
      .where(eq(schema.users.appleUserId, input.identity.sub))
      .limit(1)
      .for('update');

    if (user?.deletionState === 'deleting') {
      throw new AccountDeletionInProgressError();
    }
    if (
      user?.deletedAt &&
      user.deletedAt.getTime() < now.getTime() - DELETE_COOLDOWN_MS
    ) {
      await tx.delete(schema.users).where(eq(schema.users.id, user.id));
      user = undefined;
    }

    if (!user) {
      [user] = await tx
        .insert(schema.users)
        .values({
          appleUserId: input.identity.sub,
          email: input.identity.email,
          nickname: appleNickname(input),
          deletionState: 'provisioning',
          appleLoginReservationId: reservationId,
          appleLoginReservationExpiresAt: expiresAt,
        })
        .returning();
      if (!user) throw new Error('Failed to reserve a new Apple user');
      return {
        id: reservationId,
        userId: user.id,
        mode: 'provision',
        expiresAt,
      };
    }

    if (
      user.appleLoginReservationId &&
      user.appleLoginReservationExpiresAt &&
      user.appleLoginReservationExpiresAt > now
    ) {
      throw new AppleLoginReservationError();
    }
    const mode: AppleLoginReservationMode = user.deletedAt
      ? 'restore'
      : user.deletionState === 'provisioning'
        ? 'provision'
        : 'active';
    if (mode === 'active' && user.deletionState !== 'active') {
      throw new AccountDeletionInProgressError();
    }
    await tx
      .update(schema.users)
      .set({
        appleLoginReservationId: reservationId,
        appleLoginReservationExpiresAt: expiresAt,
        updatedAt: now,
      })
      .where(eq(schema.users.id, user.id));
    return { id: reservationId, userId: user.id, mode, expiresAt };
  });
}

async function persistPendingAppleCredential(input: {
  reservation: AppleLoginReservation;
  appleUserId: string;
  tokenHash: string;
  encryptedRefreshToken: string;
  encryptionKeyId: string;
}): Promise<{ credentialId?: string; alreadyActive: boolean }> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, input.reservation.userId))
      .limit(1)
      .for('update');
    assertCurrentReservation(user, input.reservation);

    const [inserted] = await tx
      .insert(schema.appleCredentials)
      .values({
        userId: user.id,
        appleUserId: input.appleUserId,
        tokenHash: input.tokenHash,
        encryptedRefreshToken: input.encryptedRefreshToken,
        encryptionKeyId: input.encryptionKeyId,
        status: 'pending_login',
        loginReservationId: input.reservation.id,
        nextAttemptAt: input.reservation.expiresAt,
      })
      .onConflictDoNothing({ target: schema.appleCredentials.tokenHash })
      .returning({ id: schema.appleCredentials.id });
    if (inserted) return { credentialId: inserted.id, alreadyActive: false };

    const [existing] = await tx
      .select()
      .from(schema.appleCredentials)
      .where(eq(schema.appleCredentials.tokenHash, input.tokenHash))
      .limit(1)
      .for('update');
    if (
      existing?.userId === user.id &&
      existing.appleUserId === input.appleUserId &&
      existing.status === 'active'
    ) {
      return { alreadyActive: true };
    }
    if (
      existing?.userId === user.id &&
      existing.loginReservationId === input.reservation.id &&
      existing.status === 'pending_login'
    ) {
      return { credentialId: existing.id, alreadyActive: false };
    }
    throw new Error('Apple returned a conflicting refresh credential');
  });
}

async function finalizeAppleLogin(input: {
  reservation: AppleLoginReservation;
  pendingCredentialId?: string;
  input: AppleLoginInput;
}): Promise<AppleLoginResult> {
  return db.transaction(async (tx): Promise<AppleLoginResult> => {
    let [user] = await tx
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, input.reservation.userId))
      .limit(1)
      .for('update');
    assertCurrentReservation(user, input.reservation);

    if (input.pendingCredentialId) {
      const [credential] = await tx
        .select({ id: schema.appleCredentials.id })
        .from(schema.appleCredentials)
        .where(
          and(
            eq(schema.appleCredentials.id, input.pendingCredentialId),
            eq(schema.appleCredentials.userId, user.id),
            eq(schema.appleCredentials.status, 'pending_login'),
            eq(
              schema.appleCredentials.loginReservationId,
              input.reservation.id
            )
          )
        )
        .limit(1)
        .for('update');
      if (!credential) throw new AppleLoginReservationError();
    }

    const userUpdates: Partial<typeof schema.users.$inferInsert> = {
      appleLoginReservationId: null,
      appleLoginReservationExpiresAt: null,
      updatedAt: new Date(),
    };
    if (input.reservation.mode !== 'active') {
      Object.assign(userUpdates, {
        deletedAt: null,
        deletionState: 'active',
        deletionStartedAt: null,
        deletionAuthorizedSessionId: null,
        deletionNextAttemptAt: null,
        deletionLeaseOwner: null,
        deletionLeaseUntil: null,
        deletionAttemptCount: 0,
        appleTokenRevokedAt: null,
      });
    }
    [user] = await tx
      .update(schema.users)
      .set(userUpdates)
      .where(
        and(
          eq(schema.users.id, input.reservation.userId),
          eq(schema.users.appleLoginReservationId, input.reservation.id)
        )
      )
      .returning();
    if (!user) throw new AppleLoginReservationError();

    if (input.pendingCredentialId) {
      await tx
        .update(schema.appleCredentials)
        .set({
          status: 'active',
          activatedAt: new Date(),
          loginReservationId: null,
          nextAttemptAt: null,
          leaseOwner: null,
          leaseUntil: null,
        })
        .where(eq(schema.appleCredentials.id, input.pendingCredentialId));
    }

    await tx
      .insert(schema.consentReceipts)
      .values({
        userId: user.id,
        consentVersion: input.input.consent.version,
        acceptedAt: input.input.consent.acceptedAt,
        source: input.input.consent.source,
      })
      .onConflictDoNothing({
        target: [
          schema.consentReceipts.userId,
          schema.consentReceipts.consentVersion,
        ],
      });

    const sessionId = randomUUID();
    const authenticatedAt = new Date();
    const context = { userId: user.id, sessionId, authenticatedAt };
    const localRefresh = issueRefreshToken(context);
    const localAccess = issueAccessToken(context);
    await tx.insert(schema.authSessions).values({
      id: sessionId,
      userId: user.id,
      authenticatedAt,
      expiresAt: localRefresh.expiresAt,
      lastSeenAt: authenticatedAt,
    });
    await tx.insert(schema.refreshTokens).values({
      tokenHash: hashRefreshToken(localRefresh.token),
      sessionId,
      userId: user.id,
      expiresAt: localRefresh.expiresAt,
    });
    return {
      accessToken: localAccess.token,
      refreshToken: localRefresh.token,
      user,
    };
  });
}

async function enqueueFailedAppleLoginCompensation(input: {
  reservation: AppleLoginReservation;
  appleUserId: string;
  tokenHash: string;
  encryptedRefreshToken: string;
  encryptionKeyId: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(schema.appleCredentials)
      .where(eq(schema.appleCredentials.tokenHash, input.tokenHash))
      .limit(1)
      .for('update');
    if (existing) {
      if (existing.status === 'revoked' || existing.status === 'orphaned') {
        await clearReservationInTransaction(tx, input.reservation);
        await deleteUnusedProvisioningUserInTransaction(
          tx,
          input.reservation
        );
        return;
      }
      if (
        existing.status !== 'pending_login' ||
        existing.loginReservationId !== input.reservation.id
      ) {
        throw new Error('Apple credential cannot be converted to orphan');
      }
      await tx
        .update(schema.appleCredentials)
        .set({
          userId: null,
          status: 'orphaned',
          loginReservationId: null,
          nextAttemptAt: new Date(),
          leaseOwner: null,
          leaseUntil: null,
        })
        .where(eq(schema.appleCredentials.id, existing.id));
    } else {
      await tx.insert(schema.appleCredentials).values({
        userId: null,
        appleUserId: input.appleUserId,
        tokenHash: input.tokenHash,
        encryptedRefreshToken: input.encryptedRefreshToken,
        encryptionKeyId: input.encryptionKeyId,
        status: 'orphaned',
        nextAttemptAt: new Date(),
      });
    }
    await clearReservationInTransaction(tx, input.reservation);
    await deleteUnusedProvisioningUserInTransaction(tx, input.reservation);
  });
}

async function finishFailedAppleLogin(input: {
  reservation: AppleLoginReservation;
  pendingCredentialId?: string;
  revoked: boolean;
}): Promise<void> {
  await db.transaction(async (tx) => {
    if (input.pendingCredentialId && input.revoked) {
      const now = new Date();
      await tx
        .update(schema.appleCredentials)
        .set({
          status: 'revoked',
          encryptedRefreshToken: null,
          loginReservationId: null,
          nextAttemptAt: null,
          leaseOwner: null,
          leaseUntil: null,
          lastRevocationAttemptAt: now,
          revokedAt: now,
        })
        .where(
          and(
            eq(schema.appleCredentials.id, input.pendingCredentialId),
            eq(
              schema.appleCredentials.loginReservationId,
              input.reservation.id
            )
          )
        );
    }
    await clearReservationInTransaction(tx, input.reservation);
    await deleteUnusedProvisioningUserInTransaction(tx, input.reservation);
  });
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function clearReservationInTransaction(
  tx: Transaction,
  reservation: AppleLoginReservation
): Promise<void> {
  await tx
    .update(schema.users)
    .set({
      appleLoginReservationId: null,
      appleLoginReservationExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.users.id, reservation.userId),
        eq(schema.users.appleLoginReservationId, reservation.id)
      )
    );
}

async function deleteUnusedProvisioningUserInTransaction(
  tx: Transaction,
  reservation: AppleLoginReservation
): Promise<void> {
  if (reservation.mode !== 'provision') return;
  await tx
    .delete(schema.users)
    .where(
      and(
        eq(schema.users.id, reservation.userId),
        eq(schema.users.deletionState, 'provisioning'),
        sql`${schema.users.appleLoginReservationId} is null`,
        sql`not exists (
          select 1 from ${schema.authSessions}
          where ${schema.authSessions.userId} = ${schema.users.id}
        )`,
        sql`not exists (
          select 1 from ${schema.consentReceipts}
          where ${schema.consentReceipts.userId} = ${schema.users.id}
        )`,
        sql`not exists (
          select 1 from ${schema.appleCredentials}
          where ${schema.appleCredentials.userId} = ${schema.users.id}
            and ${schema.appleCredentials.encryptedRefreshToken} is not null
        )`
      )
    );
}

function assertCurrentReservation(
  user: typeof schema.users.$inferSelect | undefined,
  reservation: AppleLoginReservation,
  now = new Date()
): asserts user is typeof schema.users.$inferSelect {
  if (
    !user ||
    !isAppleLoginReservationCurrent({
      expectedId: reservation.id,
      actualId: user.appleLoginReservationId,
      expiresAt: user.appleLoginReservationExpiresAt,
      now,
      mode: reservation.mode,
      deletionState: user.deletionState,
      deleted: Boolean(user.deletedAt),
    })
  ) {
    throw new AppleLoginReservationError();
  }
}

function appleNickname(input: AppleLoginInput): string {
  const givenName =
    typeof input.fullName?.givenName === 'string'
      ? input.fullName.givenName.trim().slice(0, 25)
      : '';
  const familyName =
    typeof input.fullName?.familyName === 'string'
      ? input.fullName.familyName.trim().slice(0, 25)
      : '';
  return (
    [familyName, givenName].filter(Boolean).join('') ||
    `用户${input.identity.sub.slice(-4)}`
  );
}
