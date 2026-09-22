import type { Card, Session } from '../types';
import { ensureDatabaseWriteCapacity } from '../storage/quota';
import { cardValues } from './cards';
import { requireCurrentOwner } from './owner';
import { getDB } from './schema';
import { normalizeChatMessages, sessionValues } from './sessions';

/**
 * Commit the generated session, every card, and the daily session counter as a
 * single unit. Re-running the same session id replaces its derived data but
 * does not increment stats twice.
 */
export async function persistGeneratedSession(
  session: Session,
  cards: Card[],
  localDate: string,
  expectedOwner: string = requireCurrentOwner()
): Promise<{ created: boolean }> {
  const owner = requireCurrentOwner();
  if (owner !== expectedOwner) {
    throw new Error('The signed-in account changed while generation was running');
  }
  ensureDatabaseWriteCapacity([
    session.id,
    session.transcript,
    session.corrected_sentences,
    session.polished_sentences,
    session.chunks,
    session.chat_history,
    cards,
  ]);
  const db = await getDB();
  let created = false;

  await db.withExclusiveTransactionAsync(async (txn) => {
    const existing = await txn.getFirstAsync<{ owner_user_id: string }>(
      'SELECT owner_user_id FROM sessions WHERE id = ?',
      [session.id]
    );
    if (existing && existing.owner_user_id !== owner) {
      throw new Error('Session identifier is already in use');
    }
    created = !existing;

    await txn.runAsync(
      `INSERT INTO sessions (
         owner_user_id, id, created_at, updated_at, photo_uri,
         photo_thumbnail_uri, recording_uri, transcript,
         corrected_sentences, polished_sentences, sentence_audio_uris,
         chunks, chat_history, summary_title, sentence_count,
         podcast_generated, cards_generated, generation_status,
         generation_error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL)
       ON CONFLICT(owner_user_id, id) DO UPDATE SET
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         photo_uri = excluded.photo_uri,
         photo_thumbnail_uri = excluded.photo_thumbnail_uri,
         recording_uri = excluded.recording_uri,
         transcript = excluded.transcript,
         corrected_sentences = excluded.corrected_sentences,
         polished_sentences = excluded.polished_sentences,
         sentence_audio_uris = excluded.sentence_audio_uris,
         chunks = excluded.chunks,
         chat_history = excluded.chat_history,
         summary_title = excluded.summary_title,
         sentence_count = excluded.sentence_count,
         podcast_generated = excluded.podcast_generated,
         cards_generated = excluded.cards_generated,
         generation_status = 'ready',
         generation_error = NULL`,
      sessionValues(owner, session, new Date().toISOString())
    );

    await txn.runAsync(
      `DELETE FROM session_chat_messages
       WHERE owner_user_id = ? AND session_id = ?`,
      [owner, session.id]
    );
    let chatSequence = 0;
    for (const message of normalizeChatMessages(session.chat_history)) {
      await txn.runAsync(
        `INSERT INTO session_chat_messages (
           owner_user_id, session_id, sequence, role, content, timestamp
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          owner,
          session.id,
          chatSequence++,
          message.role,
          message.content,
          message.timestamp,
        ]
      );
    }

    await txn.runAsync(
      `DELETE FROM cards
       WHERE owner_user_id = ? AND source_session_id = ?`,
      [owner, session.id]
    );

    for (const card of cards) {
      await txn.runAsync(
        `INSERT INTO cards (
           owner_user_id, id, chunk_id, chunk, usage_note, examples,
           photo_thumbnail_uri, source_session_id, created_at, next_review_at,
           stability, difficulty, review_history, fsrs_elapsed_days,
           fsrs_scheduled_days, fsrs_learning_steps, fsrs_reps, fsrs_lapses,
           fsrs_state, fsrs_last_review_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        cardValues(owner, card)
      );
    }

    if (created) {
      await txn.runAsync(
        `INSERT INTO stats (owner_user_id, date, session_count)
         VALUES (?, ?, 1)
         ON CONFLICT(owner_user_id, date) DO UPDATE SET
           session_count = session_count + 1`,
        [owner, localDate]
      );
    }

    // The session/chat/audio references now own every successful result. Keep
    // failed or uncertain intents for safe retry, but compact completed rows.
    await txn.runAsync(
      `DELETE FROM ai_operation_intents
       WHERE owner_user_id = ? AND session_id = ? AND state = 'completed'`,
      [owner, session.id]
    );

    if (requireCurrentOwner() !== expectedOwner) {
      throw new Error('The signed-in account changed while generation was running');
    }
  });

  return { created };
}
