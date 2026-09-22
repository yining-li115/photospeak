const STORAGE_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MANAGED_MEDIA_ROOTS = new Set([
  'audio',
  'photos',
  'thumbnails',
  'recordings',
  'users',
]);

/** Accept only canonical relative paths below an app-owned media directory. */
export function isManagedMediaRelativePath(path: string): boolean {
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('://') ||
    path.includes('\\') ||
    path.includes('?') ||
    path.includes('#')
  ) {
    return false;
  }
  const segments = path.split('/');
  if (
    segments.some(
      (segment) => !segment || segment === '.' || segment === '..'
    )
  ) {
    return false;
  }
  return MANAGED_MEDIA_ROOTS.has(segments[0]);
}

/** Reject deep-link/path traversal input before it reaches expo-file-system. */
export function assertSafeStorageKey(value: string, label = 'storage key'): void {
  if (!STORAGE_KEY.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
}

export function assertSafeFileName(value: string): void {
  if (!FILE_NAME.test(value) || value.includes('..')) {
    throw new Error('Invalid storage filename');
  }
}
