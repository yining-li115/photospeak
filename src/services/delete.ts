import { deleteCardsBySession } from '../db/cards';
import { deleteSession } from '../db/sessions';
import { deleteSessionAudio } from '../storage/audio';
import { deletePhotoFiles } from '../storage/photos';
import { deleteRecording } from '../storage/recordings';

/**
 * Cascade-delete a session and everything that hangs off it:
 *   - cards generated from this session
 *   - per-sentence podcast audio files
 *   - the original recording wav
 *   - the photo + thumbnail
 *   - the sessions row itself
 *
 * Stats rows are intentionally left alone — historical listening time
 * and review counts shouldn't shrink when a single source goes away.
 *
 * Order matters a little: we delete the row last so that even if a
 * file delete throws, the row is still around for a retry. File
 * deletes are best-effort (each catches its own errors) so a missing
 * file doesn't block the rest.
 */
export async function deleteSessionCascade(sessionId: string): Promise<void> {
  await deleteCardsBySession(sessionId);
  try {
    deleteSessionAudio(sessionId);
  } catch {
    /* swallow */
  }
  try {
    deleteRecording(sessionId);
  } catch {
    /* swallow */
  }
  try {
    deletePhotoFiles(sessionId);
  } catch {
    /* swallow */
  }
  await deleteSession(sessionId);
}
