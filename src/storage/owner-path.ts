import { Directory, Paths } from 'expo-file-system';
import { assertSafeStorageKey } from './safety';

const USERS_SUBDIR = 'users';

/**
 * Resolve a previously captured owner without consulting mutable auth state.
 * Media used to live in global folders; all new writes are namespaced here.
 */
export function ensureOwnerDirectoryFor(
  owner: string,
  subdir: string
): Directory {
  assertSafeStorageKey(subdir, 'storage directory');
  assertSafeStorageKey(owner, 'owner identifier');

  const users = new Directory(Paths.document, USERS_SUBDIR);
  if (!users.exists) users.create({ intermediates: true });
  const ownerDir = new Directory(users, owner);
  if (!ownerDir.exists) ownerDir.create({ intermediates: true });
  const target = new Directory(ownerDir, subdir);
  if (!target.exists) target.create({ intermediates: true });
  return target;
}

/** Non-creating counterpart to ensureOwnerDirectoryFor. */
export function ownerDirectoryFor(owner: string, subdir: string): Directory {
  assertSafeStorageKey(subdir, 'storage directory');
  assertSafeStorageKey(owner, 'owner identifier');
  return new Directory(Paths.document, USERS_SUBDIR, owner, subdir);
}

/** Remove the complete media namespace for one deleted account. */
export function deleteOwnerStorage(owner: string): void {
  assertSafeStorageKey(owner, 'owner identifier');
  const directory = new Directory(Paths.document, USERS_SUBDIR, owner);
  if (directory.exists) directory.delete();
}
