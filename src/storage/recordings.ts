import { Directory, File, Paths } from 'expo-file-system';

const RECORDINGS_SUBDIR = 'recordings';

function ensureDir(): Directory {
  const dir = new Directory(Paths.document, RECORDINGS_SUBDIR);
  if (!dir.exists) {
    dir.create({ intermediates: true });
  }
  return dir;
}

export function persistRecording(sourceUri: string, sessionId: string): string {
  const dir = ensureDir();
  const ext = extensionOf(sourceUri);
  const dest = new File(dir, `${sessionId}${ext}`);
  if (dest.exists) dest.delete();
  new File(sourceUri).move(dest);
  return dest.uri;
}

export function deleteRecording(sessionId: string): void {
  const dir = ensureDir();
  for (const ext of ['.m4a', '.caf', '.wav', '.mp4', '.aac']) {
    const f = new File(dir, `${sessionId}${ext}`);
    if (f.exists) f.delete();
  }
}

function extensionOf(uri: string): string {
  const match = /\.[a-zA-Z0-9]+$/.exec(uri);
  return match ? match[0] : '.m4a';
}
