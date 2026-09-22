import { Directory, File, Paths } from 'expo-file-system';
import {
  deleteOwnerRows,
  deleteSessionRows,
  listOwnerStorageFiles,
  type SessionStorageFiles,
} from '../db/sessions';
import {
  clearOwnerDeletionPending,
  listCommittedOwnerDeletions,
} from '../db/deletions';
import { requireCurrentOwner } from '../db/owner';
import { deleteOwnerStorage } from '../storage/owner-path';
import { resolveStoragePath } from '../storage/resolve';

/**
 * Delete the relational graph in one transaction, then garbage-collect files.
 * If a file operation fails, no other user's rows are exposed and the orphan
 * janitor can retry later.
 */
export async function deleteSessionCascade(sessionId: string): Promise<void> {
  const files = await deleteSessionRows(sessionId);
  if (!files) return;
  deleteFilesBestEffort(files);
}

/** Account-deletion hook: purge only the active owner's rows and media. */
export async function purgeCurrentOwnerLocalData(): Promise<void> {
  await purgeOwnerLocalData(requireCurrentOwner());
}

/** Retry-safe purge that does not depend on whichever account is active now. */
export async function purgeOwnerLocalData(owner: string): Promise<void> {
  // Read and strictly erase the manifest first. In particular, migrated beta
  // media can still live in the old global folders and is not covered by the
  // owner-directory delete. Keeping DB rows until every managed file is gone
  // means a failed filesystem operation remains retryable via the tombstone.
  const sessions = await listOwnerStorageFiles(owner);
  for (const files of sessions) deleteFilesStrict(files);
  // New media is owner-namespaced, so this also removes interrupted drafts and
  // stale photo versions that never gained a DB reference.
  deleteOwnerStorage(owner);
  await deleteOwnerRows(owner);
}

/** Resume privacy cleanup recorded before a prior logout/crash. */
export async function retryPendingLocalDeletions(): Promise<void> {
  const owners = await listCommittedOwnerDeletions();
  for (const owner of owners) {
    try {
      await purgeOwnerLocalData(owner);
      await clearOwnerDeletionPending(owner);
    } catch {
      // Keep the tombstone. A later launch retries without touching data that
      // belongs to any other owner.
    }
  }
}

function deleteFilesBestEffort(files: SessionStorageFiles): void {
  for (const uri of [
    files.photoUri,
    files.photoThumbnailUri,
    files.recordingUri,
    ...files.sentenceAudioUris,
  ]) {
    try {
      deleteManagedFile(uri);
    } catch {
      // DB deletion is already committed. Storage maintenance will discover
      // and remove the now-unreferenced file on a later launch.
    }
  }
}

function deleteFilesStrict(files: SessionStorageFiles): void {
  for (const uri of [
    files.photoUri,
    files.photoThumbnailUri,
    files.recordingUri,
    ...files.sentenceAudioUris,
  ]) {
    deleteManagedFile(uri);
  }
}

function deleteManagedFile(uri: string): void {
  if (!uri) return;
  const resolved = resolveStoragePath(uri);
  const root = new Directory(Paths.document).uri;
  if (!resolved.startsWith(root)) return;
  const relative = resolved.slice(root.length).replace(/^\/+/, '');
  if (
    !['audio/', 'photos/', 'thumbnails/', 'recordings/', 'users/'].some(
      (prefix) => relative.startsWith(prefix)
    )
  ) {
    return;
  }
  const file = new File(resolved);
  if (file.exists) file.delete();
}
