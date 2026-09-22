import { Directory, File } from 'expo-file-system';
import {
  assertAccountOperationScope,
  type AccountOperationScope,
} from '../services/account-operation';
import { ensureAppStorageCapacityForWrite } from './quota';
import { ensureOwnerDirectoryFor, ownerDirectoryFor } from './owner-path';
import { assertSafeStorageKey } from './safety';

const RECORDINGS_SUBDIR = 'recordings';
// 70 seconds of mono PCM16/16 kHz is about 2.14 MiB. Leave bounded container
// overhead while rejecting a native-module anomaly before it enters storage.
const MAX_RECORDING_BYTES = 4 * 1024 * 1024;
let lastRecordingVersion = 0;

function ensureDir(scope: AccountOperationScope): Directory {
  assertAccountOperationScope(scope);
  return ensureOwnerDirectoryFor(scope.owner, RECORDINGS_SUBDIR);
}

export function persistRecording(
  sourceUri: string,
  sessionId: string,
  scope: AccountOperationScope
): string {
  assertAccountOperationScope(scope);
  assertSafeStorageKey(sessionId, 'session identifier');
  const src = new File(sourceUri);
  const srcSize = src.exists ? src.info().size ?? 0 : 0;
  if (srcSize === 0) {
    throw new Error(
      'Recording is empty (0 bytes). Try re-recording — speak a bit louder or longer.'
    );
  }
  if (srcSize > MAX_RECORDING_BYTES) {
    throw new Error('Recording exceeded the 70-second storage safety limit');
  }
  ensureAppStorageCapacityForWrite(srcSize);
  assertAccountOperationScope(scope);

  const dir = ensureDir(scope);
  const ext = extensionOf(sourceUri);
  const filename = `${sessionId}-${nextRecordingVersion()}${ext}`;
  const dest = new File(dir, filename);
  src.move(dest);
  deleteRecordingFilesForOwner(scope.owner, sessionId, filename);
  // Returns absolute file:// URI so callers can read the file via
  // `new File(...)`. SQLite persists it via the DB layer, which strips
  // the docDirectory prefix so the path survives reinstalls.
  return dest.uri;
}

export function deleteRecording(
  sessionId: string,
  scope: AccountOperationScope
): void {
  assertAccountOperationScope(scope);
  assertSafeStorageKey(sessionId, 'session identifier');
  deleteRecordingFilesForOwner(scope.owner, sessionId);
}

function deleteRecordingFilesForOwner(
  owner: string,
  sessionId: string,
  keepFilename?: string
): void {
  const dir = ownerDirectoryFor(owner, RECORDINGS_SUBDIR);
  if (!dir.exists) return;
  for (const entry of dir.list()) {
    if (!(entry instanceof File) || entry.name === keepFilename) continue;
    const extension = extensionOf(entry.uri);
    const isLegacy = entry.name === `${sessionId}${extension}`;
    const suffix = entry.name.slice(sessionId.length + 1);
    const isVersioned =
      entry.name.startsWith(`${sessionId}-`) &&
      /^\d+\.(?:m4a|caf|wav|mp4|aac|ogg)$/.test(suffix);
    if (isLegacy || isVersioned) {
      try {
        entry.delete();
      } catch {
        // The newly persisted recording remains usable. The managed-storage
        // janitor will retry stale versions instead of failing the save.
      }
    }
  }
}

/** Delete a trusted native-recorder temporary file after a cancelled save. */
export function deleteTemporaryRecording(sourceUri: string | null): void {
  if (!sourceUri) return;
  try {
    const file = new File(sourceUri);
    if (file.exists) file.delete();
  } catch {
    // The OS may already have reclaimed the recorder's cache file.
  }
}

function extensionOf(uri: string): string {
  const extension = new File(uri).extension.toLowerCase();
  return ['.m4a', '.caf', '.wav', '.mp4', '.aac', '.ogg'].includes(extension)
    ? extension
    : '.m4a';
}

function nextRecordingVersion(): number {
  lastRecordingVersion = Math.max(Date.now(), lastRecordingVersion + 1);
  return lastRecordingVersion;
}
