import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createAppleServerTokenServiceFromEnv } from '../auth/apple-server.js';
import { classifyAppleRevocationFailure } from '../auth/recovery-policy.js';
import { claimPendingAccountDeletions } from '../auth/session-service.js';
import { closeDatabase } from '../db/client.js';
import { safeLogReference } from '../logging/safe-reference.js';
import {
  purgeDeletedAccounts,
  expireAiOperationResults,
  purgeExpiredAiOperationTombstones,
  quarantineExpiredAiOperationLeases,
  markAbandonedAppleLoginReservations,
  purgeAbandonedAppleProvisioningUsers,
  purgeExpiredAuthSessions,
  purgeExpiredRefreshTokens,
  purgeOldUsageEvents,
} from '../services/account-retention.js';
import {
  processPendingAccountDeletion,
  recoverOrphanedAppleCredentials,
} from '../services/apple-deletion-recovery.js';

async function main() {
  const configured = Number(process.env.ACCOUNT_DELETE_RETENTION_DAYS ?? 7);
  const retentionDays =
    Number.isFinite(configured) && configured >= 7 ? configured : 7;
  const usageRetentionDays = Number(
    process.env.AI_USAGE_RETENTION_DAYS ?? 400
  );
  const safeUsageRetention =
    Number.isFinite(usageRetentionDays) && usageRetentionDays >= 90
      ? usageRetentionDays
      : 400;
  const results = {
    appleDeletionRecovery: await recoverPendingAppleDeletions(),
    appleLoginReservations: await runBatchedPurge(() =>
      markAbandonedAppleLoginReservations({ limit: 250 })
    ),
    abandonedAppleUsers: await runBatchedPurge(() =>
      purgeAbandonedAppleProvisioningUsers({ limit: 250 })
    ),
    // Privacy-critical hard deletion runs first and is isolated from routine
    // token/usage cleanup failures.
    accounts: await runBatchedPurge(() =>
      purgeDeletedAccounts({ retentionDays, limit: 250 })
    ),
    sessions: await runBatchedPurge(() =>
      purgeExpiredAuthSessions({ limit: 250 })
    ),
    tokens: await runBatchedPurge(() =>
      purgeExpiredRefreshTokens({ limit: 250 })
    ),
    usage: await runBatchedPurge(() =>
      purgeOldUsageEvents({ retentionDays: safeUsageRetention, limit: 250 })
    ),
    aiResultEnvelopes: await runBatchedPurge(() =>
      expireAiOperationResults({ limit: 250 })
    ),
    aiExpiredLeases: await runBatchedPurge(() =>
      quarantineExpiredAiOperationLeases({ limit: 250 })
    ),
    aiTombstones: await runBatchedPurge(() =>
      purgeExpiredAiOperationTombstones({ limit: 250 })
    ),
  };
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'accounts.purge.complete',
      retentionDays,
      deletedAccountCount: results.accounts.count,
      deletedTokenCount: results.tokens.count,
      deletedSessionCount: results.sessions.count,
      deletedUsageCount: results.usage.count,
      expiredAiResultCount: results.aiResultEnvelopes.count,
      quarantinedExpiredAiLeaseCount: results.aiExpiredLeases.count,
      deletedAiTombstoneCount: results.aiTombstones.count,
      recoveredAppleDeletionCount: results.appleDeletionRecovery.count,
      flaggedAppleReservationCount: results.appleLoginReservations.count,
      purgedAbandonedAppleUserCount: results.abandonedAppleUsers.count,
      appleManualRevocationCount:
        results.appleDeletionRecovery.manualRequiredCount,
      failures: Object.entries(results)
        .filter(([, result]) => result.error)
        .map(([name, result]) => ({ name, error: result.error })),
    })
  );
  if (results.appleLoginReservations.count > 0) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        severity: 'high',
        event: 'auth.apple.exchange_persistence_gap_detected',
        count: results.appleLoginReservations.count,
      })
    );
  }
  if (Object.values(results).some((result) => result.error)) {
    process.exitCode = 1;
  }
}

async function recoverPendingAppleDeletions(): Promise<{
  count: number;
  manualRequiredCount: number;
  error?: string;
}> {
  try {
    const appleServer = createAppleServerTokenServiceFromEnv(
      process.env.APPLE_BUNDLE_ID ?? ''
    );
    const credentialOwner = `credential-recovery:${randomUUID()}`;
    const orphaned = await recoverOrphanedAppleCredentials({
      appleServer,
      limit: 100,
      owner: credentialOwner,
    });
    const deletionOwner = `deletion-recovery:${randomUUID()}`;
    let count = 0;
    let failures = 0;
    let manualRequiredCount = orphaned.manualRequiredCount;
    // Claim immediately before processing. Apple calls can take tens of
    // seconds, so pre-claiming 100 accounts would let later leases expire in
    // the queue and invite duplicate workers.
    for (let processed = 0; processed < 100; processed += 1) {
      const [claim] = await claimPendingAccountDeletions({
        owner: deletionOwner,
        limit: 1,
      });
      if (!claim) break;
      const result = await processPendingAccountDeletion({
        userId: claim.userId,
        appleServer,
        claimed: { ...claim, owner: deletionOwner },
      });
      if (result.status === 'deleted') {
        count += 1;
        if (result.outcome === 'manual_required') {
          manualRequiredCount += 1;
        }
      } else {
        failures += 1;
        console.warn(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: 'accounts.apple_deletion.pending',
            userRef: safeLogReference('user', claim.userId),
            status: result.status,
          })
        );
        if (
          result.status === 'revocation_failed' &&
          classifyAppleRevocationFailure(result.error) === 'configuration'
        ) {
          break;
        }
      }
    }
    const pendingCount = failures + orphaned.failedCount;
    const recoveredCount = count + orphaned.revokedCount;
    return pendingCount > 0
      ? {
          count: recoveredCount,
          manualRequiredCount,
          error: `${pendingCount} Apple credential cleanup(s) remain pending`,
        }
      : {
          count: recoveredCount,
          manualRequiredCount,
        };
  } catch (error) {
    return {
      count: 0,
      manualRequiredCount: 0,
      error: `Apple deletion recovery unavailable (${error instanceof Error ? error.name : 'unknown'})`,
    };
  }
}

async function runBatchedPurge(
  purgeOneBatch: () => Promise<number>
): Promise<{ count: number; error?: string }> {
  let count = 0;
  try {
    while (true) {
      const deleted = await purgeOneBatch();
      count += deleted;
      if (deleted < 250) return { count };
    }
  } catch (error) {
    return {
      count,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'accounts.purge.failed',
        message: error instanceof Error ? error.message : String(error),
      })
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase().catch(() => {});
  });
