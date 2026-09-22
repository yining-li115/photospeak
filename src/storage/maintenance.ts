import { listAllReferencedStoragePaths } from '../db/sessions';
import {
  deleteAbandonedCompletedSpeechIntent,
  listAbandonedCompletedSpeechIntents,
} from '../db/ai-intents';
import { MAX_SESSION_GENERATED_AUDIO_BYTES } from './generated-audio-policy';
import {
  listManagedMediaFiles,
  sumBytes,
} from './inventory';
import { ensureAppStorageCapacityForWrite } from './quota';
import { isManagedMediaRelativePath } from './safety';
const DEFAULT_ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SOFT_LIMIT_BYTES = 500 * 1024 * 1024;
// Worst-case server contract: 12 independently bounded 4 MiB speech files,
// plus room for the normalized photo, thumbnail and temporary recording.
const SESSION_WRITE_RESERVE_BYTES =
  MAX_SESSION_GENERATED_AUDIO_BYTES + 8 * 1024 * 1024;

export interface StorageCleanupOptions {
  /** Draft media younger than this is preserved so an interrupted flow can retry. */
  orphanGraceMs?: number;
  /** Report when referenced media alone exceeds this budget. */
  softLimitBytes?: number;
  nowMs?: number;
}

export interface StorageCleanupReport {
  totalBytesBefore: number;
  totalBytesAfter: number;
  freedBytes: number;
  removedFiles: number;
  failedFiles: number;
  removedAbandonedIntents: number;
  orphanBytesPreservedByGrace: number;
  overBudgetBytes: number;
}

/**
 * Remove expired drafts, failed-generation output and delete leftovers. It
 * compares against every owner's DB references, so signing in as one user can
 * never cause another local user's media to be classified as orphaned.
 */
export async function cleanupManagedStorage(
  options: StorageCleanupOptions = {}
): Promise<StorageCleanupReport> {
  const now = options.nowMs ?? Date.now();
  const grace = Math.max(0, options.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS);
  const softLimit = Math.max(
    0,
    options.softLimitBytes ?? DEFAULT_SOFT_LIMIT_BYTES
  );
  const abandonedCutoff = new Date(now - grace).toISOString();
  const abandonedIntents = await listAbandonedCompletedSpeechIntents(
    abandonedCutoff
  );
  const referenced = await listAllReferencedStoragePaths({
    abandonedSpeechIntentCutoff: abandonedCutoff,
  });
  const files = listManagedMediaFiles();
  const filesByPath = new Map(files.map((entry) => [entry.relativePath, entry]));
  const totalBytesBefore = sumBytes(files);

  const expiredOrphans = files
    .filter(
      (entry) =>
        !referenced.has(entry.relativePath) && now - entry.modifiedAt >= grace
    )
    .sort((a, b) => a.modifiedAt - b.modifiedAt);

  let freedBytes = 0;
  let removedFiles = 0;
  let failedFiles = 0;
  const removedOrAbsentPaths = new Set<string>();
  for (const entry of expiredOrphans) {
    try {
      if (entry.file.exists) entry.file.delete();
      freedBytes += entry.size;
      removedFiles += 1;
      removedOrAbsentPaths.add(entry.relativePath);
    } catch {
      failedFiles += 1;
    }
  }

  let removedAbandonedIntents = 0;
  for (const intent of abandonedIntents) {
    const path = intent.localResultPath;
    if (!isManagedMediaRelativePath(path)) continue;
    const file = filesByPath.get(path);
    // A missing file is already safely absent. If another durable session or
    // fresh intent references the same path, retain the file but release this
    // abandoned row. A fresh unreferenced file waits for the normal grace.
    const mediaIsSafe =
      !file || removedOrAbsentPaths.has(path) || referenced.has(path);
    if (!mediaIsSafe) continue;
    try {
      if (
        await deleteAbandonedCompletedSpeechIntent(intent, abandonedCutoff)
      ) {
        removedAbandonedIntents += 1;
      }
    } catch {
      // A deleted file with a surviving row is safe and will be retried on the
      // next maintenance pass. Never turn metadata cleanup into app startup
      // failure.
    }
  }

  const preserved = files.filter(
    (entry) =>
      !referenced.has(entry.relativePath) && now - entry.modifiedAt < grace
  );
  const totalBytesAfter = Math.max(0, totalBytesBefore - freedBytes);
  return {
    totalBytesBefore,
    totalBytesAfter,
    freedBytes,
    removedFiles,
    failedFiles,
    removedAbandonedIntents,
    orphanBytesPreservedByGrace: sumBytes(preserved),
    overBudgetBytes: Math.max(0, totalBytesAfter - softLimit),
  };
}

/**
 * Reserve enough space for one bounded photo plus the largest expected set of
 * compressed sentence audio. We never silently evict completed learning data.
 * The limit is a device-safety boundary, not a subscription/session quota.
 */
export async function ensureSessionStorageCapacity(): Promise<void> {
  await cleanupManagedStorage();
  ensureAppStorageCapacityForWrite(SESSION_WRITE_RESERVE_BYTES);
}
