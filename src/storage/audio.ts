import { Directory, File } from 'expo-file-system';
import {
  assertAccountOperationScope,
  type AccountOperationScope,
} from '../services/account-operation';
import { ensureAppStorageCapacityForWrite } from './quota';
import { generatedAudioByteLength } from './generated-audio-policy';
import { ensureOwnerDirectoryFor, ownerDirectoryFor } from './owner-path';
import { assertSafeFileName, assertSafeStorageKey } from './safety';

const AUDIO_SUBDIR = 'audio';

function ensureSessionDir(
  sessionId: string,
  scope: AccountOperationScope
): Directory {
  assertAccountOperationScope(scope);
  assertSafeStorageKey(sessionId, 'session identifier');
  const root = ensureOwnerDirectoryFor(scope.owner, AUDIO_SUBDIR);
  const dir = new Directory(root, sessionId);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

export function saveAudioFromBase64(
  base64: string,
  sessionId: string,
  filename: string,
  scope: AccountOperationScope
): string {
  assertAccountOperationScope(scope);
  assertSafeFileName(filename);
  const incomingBytes = generatedAudioByteLength(base64);
  const dir = ensureSessionDir(sessionId, scope);
  const file = new File(dir, filename);

  // Files are immutable checkpoints named from the logical AI intent. A crash
  // can occur after the atomic move but before SQLite marks that intent done;
  // an identical replay should reuse the complete file, not delete it first.
  if (file.exists && file.size === incomingBytes) return file.uri;

  ensureAppStorageCapacityForWrite(incomingBytes);
  // The capacity walk above can take long enough for logout/account deletion to
  // run. Re-check identity before creating the temp file.
  assertAccountOperationScope(scope);
  const temporary = new File(dir, `${filename}.tmp`);
  if (temporary.exists) temporary.delete();
  temporary.create();
  try {
    temporary.write(base64, { encoding: 'base64' });
    if (temporary.size !== incomingBytes) {
      throw new Error('Generated audio could not be written completely');
    }
    if (file.exists) file.delete();
    temporary.move(file);
  } catch (error) {
    if (temporary.exists) temporary.delete();
    throw error;
  }
  // Returns an absolute file:// URI so callers can pass it straight to
  // expo-audio / new File(...). SQLite persists it via the DB layer,
  // which strips the docDirectory prefix to a relative path so the
  // value survives sandbox UUID changes across reinstalls.
  return file.uri;
}

export function deleteSessionAudio(
  sessionId: string,
  scope: AccountOperationScope
): void {
  assertAccountOperationScope(scope);
  assertSafeStorageKey(sessionId, 'session identifier');
  const dir = new Directory(
    ownerDirectoryFor(scope.owner, AUDIO_SUBDIR),
    sessionId
  );
  if (dir.exists) dir.delete();
}
