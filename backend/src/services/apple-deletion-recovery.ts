import { randomUUID } from 'node:crypto';
import {
  claimAccountDeletionById,
  claimAppleCredentials,
  clearRecoveredAppleLoginReservation,
  finalizeAccountDeletion,
  markClaimedAppleCredentialRevoked,
  markClaimedAppleCredentialManualRequired,
  renewAccountDeletionClaim,
  renewClaimedAppleCredential,
  rescheduleAccountDeletionClaim,
  rescheduleClaimedAppleCredential,
  type AccountDeletionClaim,
} from '../auth/session-service.js';
import type { AppleDeletionOutcome } from '../auth/account-deletion-policy.js';
import {
  AppleCredentialError,
  type AppleServerTokenGateway,
} from '../auth/apple-server.js';
import {
  classifyAppleRevocationFailure,
  shouldTerminalizeAppleRevocation,
} from '../auth/recovery-policy.js';

export type AppleDeletionProcessingResult =
  | { status: 'deleted'; outcome: AppleDeletionOutcome }
  | { status: 'revocation_failed'; error: unknown }
  | { status: 'credentials_remaining' }
  | { status: 'invalid_session' };

/**
 * Idempotently revoke every durable Apple credential, then finalize local
 * deletion. Used by both the request path and the recovery job after crashes.
 */
export async function processPendingAccountDeletion(input: {
  userId: string;
  sessionId?: string;
  appleServer: AppleServerTokenGateway;
  claimed?: AccountDeletionClaim & { owner: string };
}): Promise<AppleDeletionProcessingResult> {
  const owner = input.claimed?.owner ?? `account-delete:${randomUUID()}`;
  const claim =
    input.claimed ??
    (await claimAccountDeletionById({ userId: input.userId, owner }));
  if (!claim) return { status: 'credentials_remaining' };

  const credentials = await claimAppleCredentials({
    owner,
    userId: input.userId,
    limit: 500,
  });
  let firstError: unknown;
  for (const credential of credentials) {
    const [ownsAccount, ownsCredential] = await Promise.all([
      renewAccountDeletionClaim({ userId: input.userId, owner }),
      renewClaimedAppleCredential({ credentialId: credential.id, owner }),
    ]);
    if (!ownsAccount || !ownsCredential) {
      firstError ??= new AppleCredentialError(
        'Apple credential recovery lease was lost'
      );
      continue;
    }
    if (!credential.encryptedRefreshToken) {
      const error = new AppleCredentialError(
        'Active Apple credential has no ciphertext'
      );
      const disposition = await terminalizeOrRescheduleCredential({
        credential,
        owner,
        error,
      });
      if (disposition !== 'manual_required') firstError ??= error;
      if (disposition === 'configuration_blocked') break;
      continue;
    }
    try {
      const refreshToken = input.appleServer.openRefreshToken(
        credential.encryptedRefreshToken,
        credential.appleUserId
      );
      await input.appleServer.revokeRefreshToken(refreshToken);
      await markClaimedAppleCredentialRevoked({
        credentialId: credential.id,
        owner,
      });
    } catch (error) {
      const disposition = await terminalizeOrRescheduleCredential({
        credential,
        owner,
        error,
      });
      if (disposition !== 'manual_required') firstError ??= error;
      if (disposition === 'configuration_blocked') break;
    }
  }

  if (firstError) {
    await rescheduleAccountDeletionClaim({
      userId: input.userId,
      owner,
      attemptCount: claim.attemptCount,
    }).catch(() => {});
    return { status: 'revocation_failed', error: firstError };
  }

  if (!(await renewAccountDeletionClaim({ userId: input.userId, owner }))) {
    return { status: 'credentials_remaining' };
  }

  const finalized = await finalizeAccountDeletion(
    input.userId,
    input.sessionId,
    owner
  );
  if (finalized.status !== 'deleted') {
    await rescheduleAccountDeletionClaim({
      userId: input.userId,
      owner,
      attemptCount: claim.attemptCount,
      immediate: finalized.status === 'credentials_remaining',
    }).catch(() => {});
  }
  return finalized;
}

export interface OrphanedAppleCredentialRecoveryResult {
  revokedCount: number;
  failedCount: number;
  manualRequiredCount: number;
}

/** Retry Apple credentials issued by an exchange whose login DB commit failed. */
export async function recoverOrphanedAppleCredentials(input: {
  appleServer: AppleServerTokenGateway;
  limit?: number;
  owner?: string;
}): Promise<OrphanedAppleCredentialRecoveryResult> {
  const owner = input.owner ?? `apple-credential:${randomUUID()}`;
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 50)));
  let revokedCount = 0;
  let failedCount = 0;
  let manualRequiredCount = 0;
  // Claim just before work rather than leasing a large batch while earlier
  // Apple network calls run. This keeps leases meaningful and lets multiple
  // workers share the ordered queue without duplicate long-running calls.
  for (let processed = 0; processed < limit; processed += 1) {
    const [credential] = await claimAppleCredentials({ owner, limit: 1 });
    if (!credential) break;
    try {
      if (
        !(await renewClaimedAppleCredential({
          credentialId: credential.id,
          owner,
        }))
      ) {
        throw new AppleCredentialError(
          'Apple credential recovery lease was lost'
        );
      }
      if (!credential.encryptedRefreshToken) {
        throw new AppleCredentialError(
          'Orphaned Apple credential has no ciphertext'
        );
      }
      const refreshToken = input.appleServer.openRefreshToken(
        credential.encryptedRefreshToken,
        credential.appleUserId
      );
      await input.appleServer.revokeRefreshToken(refreshToken);
      await markClaimedAppleCredentialRevoked({
        credentialId: credential.id,
        owner,
      });
      await clearRecoveredAppleLoginReservation({
        userId: credential.userId,
        reservationId: credential.loginReservationId,
      });
      revokedCount += 1;
    } catch (error) {
      const disposition = await terminalizeOrRescheduleCredential({
        credential,
        owner,
        error,
      });
      if (disposition === 'manual_required') manualRequiredCount += 1;
      else failedCount += 1;
      if (disposition === 'configuration_blocked') break;
    }
  }
  return { revokedCount, failedCount, manualRequiredCount };
}

async function terminalizeOrRescheduleCredential(input: {
  credential: {
    id: string;
    userId: string | null;
    loginReservationId: string | null;
    attemptCount: number;
    revocationStartedAt: Date;
  };
  owner: string;
  error: unknown;
}): Promise<
  'manual_required' | 'retry_scheduled' | 'configuration_blocked'
> {
  const failureClass = classifyAppleRevocationFailure(input.error);
  if (
    shouldTerminalizeAppleRevocation({
      failureClass,
      attemptCount: input.credential.attemptCount,
      revocationStartedAt: input.credential.revocationStartedAt,
    })
  ) {
    const marked = await markClaimedAppleCredentialManualRequired({
      credentialId: input.credential.id,
      owner: input.owner,
    }).catch(() => null);
    if (marked) {
      await clearRecoveredAppleLoginReservation({
        userId: marked.userId,
        reservationId: marked.reservationId,
      }).catch(() => {});
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          severity: 'high',
          event: 'auth.apple.revocation_manual_required',
          userId: marked.userId ?? '',
          credentialId: input.credential.id,
          failureClass,
          attemptCount: input.credential.attemptCount,
          errorName:
            input.error instanceof Error ? input.error.name : 'unknown',
        })
      );
      return 'manual_required';
    }
  }
  await rescheduleClaimedAppleCredential({
    credentialId: input.credential.id,
    owner: input.owner,
    attemptCount: input.credential.attemptCount,
  }).catch(() => {});
  if (failureClass === 'configuration') {
    const appleError =
      input.error instanceof Error && 'upstreamCode' in input.error
        ? (input.error as {
            upstreamCode?: string;
            httpStatus?: number;
          })
        : undefined;
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        severity: 'high',
        event: 'auth.apple.revocation_configuration_blocked',
        credentialId: input.credential.id,
        upstreamStatus: appleError?.httpStatus,
        upstreamCode: appleError?.upstreamCode,
      })
    );
    return 'configuration_blocked';
  }
  return 'retry_scheduled';
}
