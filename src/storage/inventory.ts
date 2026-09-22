import { Directory, File, Paths } from 'expo-file-system';
import { defaultDatabaseDirectory } from 'expo-sqlite';
import { toRelativeStoragePath } from './resolve';

export const DATABASE_NAME = 'photospeak.db';

// The four legacy folders remain managed until beta data has been migrated or
// deleted. Current accounts write below users/<owner>/... instead.
const MANAGED_MEDIA_SUBDIRS = [
  'audio',
  'photos',
  'thumbnails',
  'recordings',
  'users',
] as const;

export interface ManagedMediaFile {
  file: File;
  relativePath: string;
  size: number;
  modifiedAt: number;
}

export interface AppStorageUsage {
  mediaBytes: number;
  databaseBytes: number;
  totalBytes: number;
}

/** Complete file inventory is reserved for orphan cleanup, not hot DB writes. */
export function listManagedMediaFiles(): ManagedMediaFile[] {
  const files: ManagedMediaFile[] = [];
  for (const subdir of MANAGED_MEDIA_SUBDIRS) {
    const directory = new Directory(Paths.document, subdir);
    if (directory.exists) walk(directory, files);
  }
  return files;
}

/**
 * Count every app-owned payload, including SQLite's WAL/SHM/journal sidecars.
 * Directory.size avoids walking every sentence-audio file on each small write;
 * platforms that cannot provide it fall back to the safe full inventory.
 */
export function getAppStorageUsage(): AppStorageUsage {
  const mediaBytes = getManagedMediaBytes();
  const databaseBytes = getDatabaseStorageBytes();
  return {
    mediaBytes,
    databaseBytes,
    totalBytes: mediaBytes + databaseBytes,
  };
}

export function getManagedMediaBytes(): number {
  let total = 0;
  let needsFallbackInventory = false;
  for (const subdir of MANAGED_MEDIA_SUBDIRS) {
    const directory = new Directory(Paths.document, subdir);
    if (!directory.exists) continue;
    const size = directory.size;
    if (size === null || !Number.isFinite(size) || size < 0) {
      needsFallbackInventory = true;
      break;
    }
    total += size;
  }
  return needsFallbackInventory
    ? sumBytes(listManagedMediaFiles())
    : total;
}

export function getDatabaseStorageBytes(): number {
  const directory = new Directory(defaultDatabaseDirectory as string);
  if (!directory.exists) return 0;

  let entries: (File | Directory)[];
  try {
    entries = directory.list();
  } catch {
    // Failing closed here would lock a healthy app out after a transient file
    // metadata error. The device free-space floor remains the final guard.
    return 0;
  }

  return entries.reduce((total, entry) => {
    if (entry instanceof Directory) return total;
    const encodedName = entry.uri.slice(entry.uri.lastIndexOf('/') + 1);
    const name = safeDecodeURIComponent(encodedName);
    if (name !== DATABASE_NAME && !name.startsWith(`${DATABASE_NAME}-`)) {
      return total;
    }
    return total + Math.max(0, entry.size);
  }, 0);
}

export function sumBytes(files: readonly ManagedMediaFile[]): number {
  return files.reduce((sum, entry) => sum + Math.max(0, entry.size), 0);
}

function walk(directory: Directory, output: ManagedMediaFile[]): void {
  let entries: (File | Directory)[];
  try {
    entries = directory.list();
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry instanceof Directory) {
      walk(entry, output);
      continue;
    }
    output.push({
      file: entry,
      relativePath: toRelativeStoragePath(entry.uri),
      size: entry.size,
      // Unknown timestamps are fresh: never delete an active draft merely
      // because a platform could not return file metadata.
      modifiedAt: entry.modificationTime ?? entry.creationTime ?? Date.now(),
    });
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
