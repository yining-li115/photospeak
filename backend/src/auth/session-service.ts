import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import {
  hashRefreshToken,
  isRecentAuthentication,
  issueAccessToken,
  issueRefreshToken,
  verifyToken,
} from './jwt.js';
import { classifyRefreshAttempt } from './session-policy.js';
import {
  RefreshReplayVault,
  hashRefreshIdempotencyKey,
  isRefreshReplayEligible,
  isValidRefreshIdempotencyKey,
  materializeRefreshReplay,
} from './refresh-replay.js';
import {
  buildClaimAccountDeletionBatchQuery,
  buildClaimAppleCredentialBatchQuery,
} from './recovery-queries.js';
import {
  recoveryBatchLimit,
  recoveryLeaseUntil,
  recoveryRetryAt,
} from './recovery-policy.js';
import {
  appleDeletionOutcome,
  decideDeletionStart,
  type AppleDeletionOutcome,
} from './account-deletion-policy.js';

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

export class AccountDeletionInProgressError extends Error {
  constructor() {
    super('Account deletion is in progress');
    this.name = 'AccountDeletionInProgressError';
  }
}

export async function createLoginSession(
  userId: string
): Promise<SessionTokens> {
  const sessionId = randomUUID();
  const authenticatedAt = new Date();
  const context = { userId, sessionId, authenticatedAt };
  const refresh = issueRefreshToken(context);
  const access = issueAccessToken(context);

  await db.transaction(async (tx) => {
    const [activeUser] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.id, userId),
          isNull(schema.users.deletedAt),
          eq(schema.users.deletionState, 'active')
        )
      )
      .limit(1)
      .for('update');
    if (!activeUser) throw new AccountDeletionInProgressError();
    await tx.insert(schema.authSessions).values({
      id: sessionId,
      userId,
      authenticatedAt,
      expiresAt: refresh.expiresAt,
      lastSeenAt: authenticatedAt,
    });
    await tx.insert(schema.refreshTokens).values({
      tokenHash: hashRefreshToken(refresh.token),
      sessionId,
      userId,
      expiresAt: refresh.expiresAt,
    });
  });

  return { accessToken: access.token, refreshToken: refresh.token };
}

export type RefreshRotationResult =
  | { status: 'success'; tokens: SessionTokens; replayed?: boolean }
  | { status: 'invalid' }
  | { status: 'invalid_idempotency_key' }
  | { status: 'reuse_detected' };

const refreshReplayVault = new RefreshReplayVault(
  process.env.JWT_SECRET ?? ''
);

/** Rotate a one-time refresh token while preserving the family's absolute TTL. */
export async function rotateRefreshToken(
  rawToken: string,
  idempotencyKey?: string
): Promise<RefreshRotationResult> {
  if (idempotencyKey && !isValidRefreshIdempotencyKey(idempotencyKey)) {
    return { status: 'invalid_idempotency_key' };
  }
  let payload;
  try {
    payload = verifyToken(rawToken, 'refresh');
  } catch {
    return { status: 'invalid' };
  }
  const tokenHash = hashRefreshToken(rawToken);
  const idempotencyKeyHash = idempotencyKey
    ? hashRefreshIdempotencyKey(idempotencyKey)
    : undefined;
  const now = new Date();

  return db.transaction(async (tx): Promise<RefreshRotationResult> => {
    // All family mutations lock the session first, then token rows. Keeping a
    // single lock order makes refresh/logout/delete races deterministic.
    const [session] = await tx
      .select()
      .from(schema.authSessions)
      .where(
        and(
          eq(schema.authSessions.id, payload.sid),
          eq(schema.authSessions.userId, payload.sub)
        )
      )
      .limit(1)
      .for('update');
    if (!session || session.revokedAt || session.expiresAt <= now) {
      return { status: 'invalid' };
    }

    const [user] = await tx
      .select({
        id: schema.users.id,
        deletedAt: schema.users.deletedAt,
        deletionState: schema.users.deletionState,
      })
      .from(schema.users)
      .where(eq(schema.users.id, payload.sub))
      .limit(1);
    if (!user || user.deletedAt || user.deletionState !== 'active') {
      return { status: 'invalid' };
    }

    const [stored] = await tx
      .select()
      .from(schema.refreshTokens)
      .where(
        and(
          eq(schema.refreshTokens.tokenHash, tokenHash),
          eq(schema.refreshTokens.sessionId, session.id),
          eq(schema.refreshTokens.userId, payload.sub)
        )
      )
      .limit(1)
      .for('update');

    if (
      stored &&
      idempotencyKeyHash &&
      isRefreshReplayEligible({
        expectedKeyHash: idempotencyKeyHash,
        storedKeyHash: stored.rotationIdempotencyKeyHash,
        envelope: stored.rotationReplayEnvelope,
        expiresAt: stored.rotationReplayExpiresAt,
        revocationReason: stored.revocationReason,
        now,
      })
    ) {
      try {
        const replay = refreshReplayVault.open({
          envelope: stored.rotationReplayEnvelope!,
          oldTokenHash: tokenHash,
          idempotencyKeyHash,
          sessionId: session.id,
        });
        if (
          !stored.replacedByTokenHash ||
          hashRefreshToken(replay.refreshToken) !== stored.replacedByTokenHash
        ) {
          throw new Error('Refresh replay child binding is invalid');
        }
        // Never replay the originally issued access token. This retry can
        // arrive hours later after a mobile process was killed before secure
        // storage committed the first response. The locked, active session
        // and user were checked above, so issue a fresh short-lived access JWT
        // while returning the exact same child refresh token.
        const access = issueAccessToken({
          userId: payload.sub,
          sessionId: session.id,
          authenticatedAt: session.authenticatedAt,
        });
        return {
          status: 'success',
          replayed: true,
          tokens: materializeRefreshReplay(replay, () => access.token),
        };
      } catch {
        // A corrupt/misbound replay record is handled as reuse below, which
        // fails closed by revoking the family.
      }
    }

    const attemptState = classifyRefreshAttempt({
      stored,
      tokenExpSeconds: payload.exp,
      tokenAuthTimeSeconds: payload.auth_time,
      sessionAuthenticatedAt: session.authenticatedAt,
      now,
    });
    if (attemptState === 'reuse_detected') {
      await tx
        .update(schema.authSessions)
        .set({
          revokedAt: now,
          revocationReason: 'refresh_reuse_detected',
          lastSeenAt: now,
        })
        .where(eq(schema.authSessions.id, session.id));
      await tx
        .update(schema.refreshTokens)
        .set({
          revokedAt: now,
          revocationReason: 'family_revoked_reuse',
        })
        .where(
          and(
            eq(schema.refreshTokens.sessionId, session.id),
            isNull(schema.refreshTokens.revokedAt)
          )
        );
      return { status: 'reuse_detected' };
    }
    if (attemptState === 'invalid' || !stored) return { status: 'invalid' };

    const context = {
      userId: payload.sub,
      sessionId: session.id,
      authenticatedAt: session.authenticatedAt,
    };
    const nextRefresh = issueRefreshToken(context, session.expiresAt);
    const nextAccess = issueAccessToken(context);
    const nextHash = hashRefreshToken(nextRefresh.token);
    const replayEnvelope = idempotencyKeyHash
      ? refreshReplayVault.seal({
          payload: { refreshToken: nextRefresh.token },
          oldTokenHash: tokenHash,
          idempotencyKeyHash,
          sessionId: session.id,
        })
      : null;

    await tx.insert(schema.refreshTokens).values({
      tokenHash: nextHash,
      sessionId: session.id,
      userId: payload.sub,
      parentTokenHash: tokenHash,
      expiresAt: nextRefresh.expiresAt,
    });
    await tx
      .update(schema.refreshTokens)
      .set({
        usedAt: now,
        revokedAt: now,
        revocationReason: 'rotated',
        replacedByTokenHash: nextHash,
        rotationIdempotencyKeyHash: idempotencyKeyHash ?? null,
        rotationReplayEnvelope: replayEnvelope,
        rotationReplayExpiresAt: replayEnvelope
          ? session.expiresAt
          : null,
      })
      .where(eq(schema.refreshTokens.tokenHash, tokenHash));
    if (stored.parentTokenHash) {
      // Successfully using the child proves the previous rotation response was
      // durably committed on the client; its parent's replay payload is no
      // longer needed.
      await tx
        .update(schema.refreshTokens)
        .set({
          rotationIdempotencyKeyHash: null,
          rotationReplayEnvelope: null,
          rotationReplayExpiresAt: null,
        })
        .where(eq(schema.refreshTokens.tokenHash, stored.parentTokenHash));
    }
    await tx
      .update(schema.authSessions)
      .set({ lastSeenAt: now })
      .where(eq(schema.authSessions.id, session.id));

    return {
      status: 'success',
      tokens: {
        accessToken: nextAccess.token,
        refreshToken: nextRefresh.token,
      },
    };
  });
}

/** Revoke the current login family, immediately invalidating its access JWTs. */
export async function revokeSession(
  userId: string,
  sessionId: string,
  reason = 'logout'
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    const [session] = await tx
      .select({ id: schema.authSessions.id })
      .from(schema.authSessions)
      .where(
        and(
          eq(schema.authSessions.id, sessionId),
          eq(schema.authSessions.userId, userId)
        )
      )
      .limit(1)
      .for('update');
    if (!session) return;
    await tx
      .update(schema.authSessions)
      .set({ revokedAt: now, revocationReason: reason, lastSeenAt: now })
      .where(eq(schema.authSessions.id, sessionId));
    await tx
      .update(schema.refreshTokens)
      .set({ revokedAt: now, revocationReason: reason })
      .where(
        and(
          eq(schema.refreshTokens.sessionId, sessionId),
          isNull(schema.refreshTokens.revokedAt)
        )
      );
  });
}

export type BeginAccountDeletionResult =
  | { status: 'ready'; appleUserId: string | null }
  | { status: 'recent_auth_required' }
  | { status: 'invalid_session' };

/** Persist deletion intent before any external Apple revocation call. */
export async function beginAccountDeletion(
  userId: string,
  sessionId: string
): Promise<BeginAccountDeletionResult> {
  const now = new Date();
  return db.transaction(async (tx): Promise<BeginAccountDeletionResult> => {
    const [session] = await tx
      .select()
      .from(schema.authSessions)
      .where(
        and(
          eq(schema.authSessions.id, sessionId),
          eq(schema.authSessions.userId, userId),
          isNull(schema.authSessions.revokedAt),
          gt(schema.authSessions.expiresAt, now)
        )
      )
      .limit(1)
      .for('update');
    if (!session) return { status: 'invalid_session' };

    const [user] = await tx
      .select({
        id: schema.users.id,
        appleUserId: schema.users.appleUserId,
        deletedAt: schema.users.deletedAt,
        deletionState: schema.users.deletionState,
        deletionStartedAt: schema.users.deletionStartedAt,
        deletionAuthorizedSessionId:
          schema.users.deletionAuthorizedSessionId,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1)
      .for('update');
    if (!user) return { status: 'invalid_session' };
    const decision = decideDeletionStart({
      deletionState: user.deletionState,
      deleted: Boolean(user.deletedAt),
      authorizedSessionId: user.deletionAuthorizedSessionId,
      currentSessionId: sessionId,
      recentAuthentication: isRecentAuthentication(
        session.authenticatedAt,
        now
      ),
    });
    if (decision === 'invalid') return { status: 'invalid_session' };
    if (decision === 'recent_auth_required') {
      return { status: 'recent_auth_required' };
    }
    if (decision === 'resume') {
      await tx
        .update(schema.users)
        .set({
          deletionNextAttemptAt: null,
          appleLoginReservationId: null,
          appleLoginReservationExpiresAt: null,
          updatedAt: now,
        })
        .where(eq(schema.users.id, userId));
      return { status: 'ready', appleUserId: user.appleUserId };
    }

    await tx
      .update(schema.users)
      .set({
        deletionState: 'deleting',
        deletionStartedAt:
          decision === 'takeover' ? user.deletionStartedAt ?? now : now,
        deletionAuthorizedSessionId: sessionId,
        deletionNextAttemptAt: null,
        appleLoginReservationId: null,
        appleLoginReservationExpiresAt: null,
        ...(decision === 'begin'
          ? {
              deletionAttemptCount: 0,
              deletionLeaseOwner: null,
              deletionLeaseUntil: null,
            }
          : {}),
        updatedAt: now,
      })
      .where(eq(schema.users.id, userId));
    return { status: 'ready', appleUserId: user.appleUserId };
  });
}

export interface AppleCredentialForRevocation
  extends Record<string, unknown> {
  id: string;
  userId: string | null;
  appleUserId: string;
  encryptedRefreshToken: string | null;
  encryptionKeyId: string;
  status: string;
  loginReservationId: string | null;
  attemptCount: number;
  revocationStartedAt: Date;
}

export interface AccountDeletionClaim extends Record<string, unknown> {
  userId: string;
  attemptCount: number;
}

export async function claimPendingAccountDeletions(input: {
  owner: string;
  now?: Date;
  leaseMs?: number;
  limit?: number;
}): Promise<AccountDeletionClaim[]> {
  const now = input.now ?? new Date();
  const result = await db.execute<AccountDeletionClaim>(
    buildClaimAccountDeletionBatchQuery({
      owner: input.owner,
      now,
      leaseUntil: recoveryLeaseUntil(now, input.leaseMs),
      limit: input.limit,
    })
  );
  return result.rows;
}

export async function claimAccountDeletionById(input: {
  userId: string;
  owner: string;
  now?: Date;
  leaseMs?: number;
}): Promise<AccountDeletionClaim | null> {
  const now = input.now ?? new Date();
  const result = await db.execute<AccountDeletionClaim>(
    buildClaimAccountDeletionBatchQuery({
      owner: input.owner,
      now,
      leaseUntil: recoveryLeaseUntil(now, input.leaseMs),
      limit: 1,
      userId: input.userId,
    })
  );
  return result.rows[0] ?? null;
}

export async function claimAppleCredentials(input: {
  owner: string;
  userId?: string;
  now?: Date;
  leaseMs?: number;
  limit?: number;
}): Promise<AppleCredentialForRevocation[]> {
  const now = input.now ?? new Date();
  const result = await db.execute<AppleCredentialForRevocation>(
    buildClaimAppleCredentialBatchQuery({
      owner: input.owner,
      now,
      leaseUntil: recoveryLeaseUntil(now, input.leaseMs),
      limit: recoveryBatchLimit(input.limit),
      userId: input.userId,
    })
  );
  return result.rows;
}

export async function markClaimedAppleCredentialRevoked(input: {
  credentialId: string;
  owner: string;
  revokedAt?: Date;
}): Promise<void> {
  const revokedAt = input.revokedAt ?? new Date();
  await db
    .update(schema.appleCredentials)
    .set({
      status: 'revoked',
      encryptedRefreshToken: null,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseUntil: null,
      lastRevocationAttemptAt: revokedAt,
      revokedAt,
    })
    .where(
      and(
        eq(schema.appleCredentials.id, input.credentialId),
        eq(schema.appleCredentials.leaseOwner, input.owner)
      )
    );
}

export async function rescheduleClaimedAppleCredential(input: {
  credentialId: string;
  owner: string;
  attemptCount: number;
  attemptedAt?: Date;
}): Promise<void> {
  const attemptedAt = input.attemptedAt ?? new Date();
  await db
    .update(schema.appleCredentials)
    .set({
      nextAttemptAt: recoveryRetryAt(input.attemptCount, attemptedAt),
      leaseOwner: null,
      leaseUntil: null,
      lastRevocationAttemptAt: attemptedAt,
    })
    .where(
      and(
        eq(schema.appleCredentials.id, input.credentialId),
        eq(schema.appleCredentials.leaseOwner, input.owner)
      )
    );
}

export async function renewClaimedAppleCredential(input: {
  credentialId: string;
  owner: string;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const rows = await db
    .update(schema.appleCredentials)
    .set({ leaseUntil: recoveryLeaseUntil(now) })
    .where(
      and(
        eq(schema.appleCredentials.id, input.credentialId),
        eq(schema.appleCredentials.leaseOwner, input.owner)
      )
    )
    .returning({ id: schema.appleCredentials.id });
  return rows.length === 1;
}

export async function markClaimedAppleCredentialManualRequired(input: {
  credentialId: string;
  owner: string;
  attemptedAt?: Date;
}): Promise<{ userId: string | null; reservationId: string | null } | null> {
  const attemptedAt = input.attemptedAt ?? new Date();
  return db.transaction(async (tx) => {
    const [credential] = await tx
      .update(schema.appleCredentials)
      .set({
        status: 'manual_required',
        encryptedRefreshToken: null,
        nextAttemptAt: null,
        leaseOwner: null,
        leaseUntil: null,
        lastRevocationAttemptAt: attemptedAt,
      })
      .where(
        and(
          eq(schema.appleCredentials.id, input.credentialId),
          eq(schema.appleCredentials.leaseOwner, input.owner)
        )
      )
      .returning({
        userId: schema.appleCredentials.userId,
        reservationId: schema.appleCredentials.loginReservationId,
      });
    if (!credential) return null;
    if (credential.userId) {
      await tx
        .update(schema.users)
        .set({
          appleManualRevokeRequiredAt: attemptedAt,
          appleLoginReservationId: null,
          appleLoginReservationExpiresAt: null,
          updatedAt: attemptedAt,
        })
        .where(eq(schema.users.id, credential.userId));
    }
    return credential;
  });
}

export async function rescheduleAccountDeletionClaim(input: {
  userId: string;
  owner: string;
  attemptCount: number;
  attemptedAt?: Date;
  immediate?: boolean;
}): Promise<void> {
  const attemptedAt = input.attemptedAt ?? new Date();
  await db
    .update(schema.users)
    .set({
      deletionNextAttemptAt: input.immediate
        ? attemptedAt
        : recoveryRetryAt(input.attemptCount, attemptedAt),
      deletionLeaseOwner: null,
      deletionLeaseUntil: null,
      updatedAt: attemptedAt,
    })
    .where(
      and(
        eq(schema.users.id, input.userId),
        eq(schema.users.deletionLeaseOwner, input.owner),
        eq(schema.users.deletionState, 'deleting')
      )
    );
}

export async function renewAccountDeletionClaim(input: {
  userId: string;
  owner: string;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const rows = await db
    .update(schema.users)
    .set({ deletionLeaseUntil: recoveryLeaseUntil(now) })
    .where(
      and(
        eq(schema.users.id, input.userId),
        eq(schema.users.deletionLeaseOwner, input.owner),
        eq(schema.users.deletionState, 'deleting')
      )
    )
    .returning({ id: schema.users.id });
  return rows.length === 1;
}

export async function clearRecoveredAppleLoginReservation(input: {
  userId: string | null;
  reservationId: string | null;
}): Promise<void> {
  if (!input.userId || !input.reservationId) return;
  await db
    .update(schema.users)
    .set({
      appleLoginReservationId: null,
      appleLoginReservationExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.users.id, input.userId),
        eq(schema.users.appleLoginReservationId, input.reservationId)
      )
    );
}

export type FinalizeAccountDeletionResult =
  | { status: 'deleted'; outcome: AppleDeletionOutcome }
  | { status: 'credentials_remaining' }
  | { status: 'invalid_session' };

/** Commit local deletion only after every durable Apple credential is revoked. */
export async function finalizeAccountDeletion(
  userId: string,
  sessionId: string | undefined,
  claimOwner: string
): Promise<FinalizeAccountDeletionResult> {
  const now = new Date();
  return db.transaction(async (tx): Promise<FinalizeAccountDeletionResult> => {
    // A recovery worker has no current request session. Lock every session in
    // stable order before the user row so it cannot deadlock with a concurrent
    // recent-session takeover (which also locks a session before the user).
    const sessions = await tx
      .select({
        id: schema.authSessions.id,
        expiresAt: schema.authSessions.expiresAt,
        revokedAt: schema.authSessions.revokedAt,
      })
      .from(schema.authSessions)
      .where(eq(schema.authSessions.userId, userId))
      .orderBy(schema.authSessions.id)
      .for('update');
    if (sessionId) {
      const currentSession = sessions.find((session) => session.id === sessionId);
      if (
        !currentSession ||
        currentSession.revokedAt ||
        currentSession.expiresAt <= now
      ) {
        return { status: 'invalid_session' };
      }
    }

    const [user] = await tx
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1)
      .for('update');
    if (
      !user ||
      user.deletedAt ||
      user.deletionState !== 'deleting' ||
      user.deletionLeaseOwner !== claimOwner ||
      (sessionId && user.deletionAuthorizedSessionId !== sessionId)
    ) {
      return { status: 'invalid_session' };
    }

    const [remainingCredential] = await tx
      .select({ id: schema.appleCredentials.id })
      .from(schema.appleCredentials)
      .where(
        and(
          eq(schema.appleCredentials.userId, userId),
          sql`${schema.appleCredentials.status} in ('active', 'pending_login')`
        )
      )
      .limit(1)
      .for('update');
    if (remainingCredential) return { status: 'credentials_remaining' };

    const [activatedAppleCredential] = await tx
      .select({ id: schema.appleCredentials.id })
      .from(schema.appleCredentials)
      .where(
        and(
          eq(schema.appleCredentials.userId, userId),
          isNotNull(schema.appleCredentials.activatedAt)
        )
      )
      .limit(1);
    const outcome = user.appleManualRevokeRequiredAt
      ? 'manual_required'
      : appleDeletionOutcome(
          user.appleUserId,
          activatedAppleCredential ? 1 : 0
        );

    await tx
      .update(schema.users)
      .set({
        deletedAt: now,
        updatedAt: now,
        deletionState: 'deleted',
        deletionAuthorizedSessionId: null,
        deletionNextAttemptAt: null,
        deletionLeaseOwner: null,
        deletionLeaseUntil: null,
        appleLoginReservationId: null,
        appleLoginReservationExpiresAt: null,
        appleTokenRevokedAt: outcome === 'revoked' ? now : null,
        appleManualRevokeRequiredAt:
          outcome === 'manual_required' ? now : null,
      })
      .where(eq(schema.users.id, userId));

    await tx
      .update(schema.authSessions)
      .set({
        revokedAt: now,
        revocationReason: 'account_deleted',
        lastSeenAt: now,
      })
      .where(
        and(
          eq(schema.authSessions.userId, userId),
          isNull(schema.authSessions.revokedAt)
        )
      );
    await tx
      .update(schema.refreshTokens)
      .set({ revokedAt: now, revocationReason: 'account_deleted' })
      .where(
        and(
          eq(schema.refreshTokens.userId, userId),
          isNull(schema.refreshTokens.revokedAt)
        )
      );
    return { status: 'deleted', outcome };
  });
}
