import { Directory, Paths } from 'expo-file-system';

/**
 * iOS sandbox container UUID changes between reinstalls (and sometimes
 * between dev rebuilds), so absolute file:// paths persisted in SQLite
 * become invalid. We store paths *relative* to the app's document
 * directory (e.g. "audio/<sessionId>/sentence-0.wav") and resolve them
 * to absolute file:// URIs at read time using whatever document
 * directory is currently active.
 */

let cachedDocRoot: string | null = null;
function docRoot(): string {
  if (cachedDocRoot === null) {
    // Directory.uri is a file:// URL with a trailing slash.
    cachedDocRoot = new Directory(Paths.document).uri;
  }
  return cachedDocRoot;
}

/**
 * Subdirs we own under documentDirectory. Used to rescue legacy
 * absolute paths whose sandbox UUID has changed: any path containing
 * "/Documents/<one-of-these>/..." can be safely re-rooted under the
 * current docDirectory.
 */
const OWNED_SUBDIRS = ['audio/', 'photos/', 'thumbnails/', 'recordings/'];

function extractOwnedRelative(uri: string): string | null {
  for (const sub of OWNED_SUBDIRS) {
    const marker = `/Documents/${sub}`;
    const idx = uri.lastIndexOf(marker);
    if (idx >= 0) return uri.slice(idx + '/Documents/'.length);
  }
  return null;
}

/**
 * Take a stored path (relative or any legacy absolute) and return an
 * absolute file:// URI suitable for expo-audio / expo-image.
 *
 * - Relative ("audio/abc/x.wav") → "${docRoot}audio/abc/x.wav"
 * - Legacy absolute under any /Documents/<owned-subdir>/ (i.e. saved
 *   with an older sandbox UUID) → re-rooted under current docRoot.
 *   This rescues old sessions when iOS preserves the file but the
 *   UUID in the path went stale across an `expo run:ios` rebuild.
 * - Other absolute (asset://, ph://, http://) → returned unchanged.
 */
export function resolveStoragePath(stored: string): string {
  if (!stored) return stored;
  const root = docRoot().replace(/\/$/, '');
  const isAbsolute = stored.includes('://') || stored.startsWith('/');
  if (!isAbsolute) {
    return `${root}/${stored.replace(/^\/+/, '')}`;
  }
  // Absolute. If it points into a Documents/<owned-subdir>/, re-root
  // it onto the current sandbox UUID. Otherwise pass through.
  const owned = extractOwnedRelative(stored);
  if (owned !== null) return `${root}/${owned}`;
  return stored;
}

/**
 * Inverse of resolveStoragePath. If a caller hands us an absolute path
 * (e.g. UI round-trips a resolved URI back), strip the doc-root prefix
 * so SQLite holds only the stable relative form.
 *
 * - Absolute under any /Documents/<owned-subdir>/ → relative
 * - Already relative → returned unchanged
 * - Absolute outside (asset:/..., ph://...) → returned unchanged
 */
export function toRelativeStoragePath(uri: string): string {
  if (!uri) return uri;
  const isAbsolute = uri.includes('://') || uri.startsWith('/');
  if (!isAbsolute) return uri;
  const owned = extractOwnedRelative(uri);
  if (owned !== null) return owned;
  return uri;
}
