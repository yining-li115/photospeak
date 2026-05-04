import { Directory, File, Paths } from 'expo-file-system';

const AUDIO_SUBDIR = 'audio';

function ensureSessionDir(sessionId: string): Directory {
  const root = new Directory(Paths.document, AUDIO_SUBDIR);
  if (!root.exists) root.create({ intermediates: true });
  const dir = new Directory(root, sessionId);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

export function saveAudioFromBase64(
  base64: string,
  sessionId: string,
  filename: string
): string {
  const dir = ensureSessionDir(sessionId);
  const file = new File(dir, filename);
  if (file.exists) file.delete();
  file.create();
  file.write(base64, { encoding: 'base64' });
  // Returns an absolute file:// URI so callers can pass it straight to
  // expo-audio / new File(...). SQLite persists it via the DB layer,
  // which strips the docDirectory prefix to a relative path so the
  // value survives sandbox UUID changes across reinstalls.
  return file.uri;
}

export function deleteSessionAudio(sessionId: string): void {
  const dir = new Directory(Paths.document, AUDIO_SUBDIR, sessionId);
  if (dir.exists) dir.delete();
}
