import {
  resolveStoragePath,
  toRelativeStoragePath,
} from '../storage/resolve';
import type {
  ChatMessage,
  Chunk,
  CorrectedSentence,
  Session,
} from '../types';
import {
  boolFromInt,
  getDB,
  intFromBool,
  parseJsonArray,
  stringifyJson,
} from './schema';

type SqlValue = string | number | null;

interface SessionRow {
  id: string;
  created_at: string;
  photo_uri: string;
  photo_thumbnail_uri: string;
  recording_uri: string;
  transcript: string | null;
  corrected_sentences: string | null;
  polished_sentences: string | null;
  sentence_audio_uris: string | null;
  chunks: string | null;
  chat_history: string | null;
  podcast_generated: number;
  cards_generated: number;
}

function rowToSession(row: SessionRow): Session {
  // Storage paths are persisted relative to documentDirectory; resolve
  // them to absolute file:// URIs here so the rest of the app can pass
  // them straight to <Image>, expo-audio, etc.
  return {
    id: row.id,
    created_at: row.created_at,
    photo_uri: resolveStoragePath(row.photo_uri),
    photo_thumbnail_uri: resolveStoragePath(row.photo_thumbnail_uri),
    recording_uri: resolveStoragePath(row.recording_uri),
    transcript: row.transcript ?? '',
    corrected_sentences: parseJsonArray<CorrectedSentence>(
      row.corrected_sentences
    ),
    polished_sentences: parseJsonArray<string>(row.polished_sentences),
    sentence_audio_uris: parseJsonArray<string>(row.sentence_audio_uris).map(
      resolveStoragePath
    ),
    chunks: parseJsonArray<Chunk>(row.chunks),
    chat_history: parseJsonArray<ChatMessage>(row.chat_history),
    podcast_generated: boolFromInt(row.podcast_generated),
    cards_generated: boolFromInt(row.cards_generated),
  };
}

export async function createSession(s: Session): Promise<void> {
  const db = await getDB();
  await db.runAsync(
    `INSERT INTO sessions (
      id, created_at, photo_uri, photo_thumbnail_uri, recording_uri,
      transcript, corrected_sentences, polished_sentences, sentence_audio_uris,
      chunks, chat_history, podcast_generated, cards_generated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      s.id,
      s.created_at,
      // Idempotent: storage layer already returns relative paths, but
      // a UI caller round-tripping a resolved URI would otherwise reach
      // here as absolute. Strip docRoot so SQLite always holds relative.
      toRelativeStoragePath(s.photo_uri),
      toRelativeStoragePath(s.photo_thumbnail_uri),
      toRelativeStoragePath(s.recording_uri),
      s.transcript,
      stringifyJson(s.corrected_sentences),
      stringifyJson(s.polished_sentences),
      stringifyJson(s.sentence_audio_uris.map(toRelativeStoragePath)),
      stringifyJson(s.chunks),
      stringifyJson(s.chat_history),
      intFromBool(s.podcast_generated),
      intFromBool(s.cards_generated),
    ]
  );
}

export async function getSession(id: string): Promise<Session | null> {
  const db = await getDB();
  const row = await db.getFirstAsync<SessionRow>(
    'SELECT * FROM sessions WHERE id = ?',
    [id]
  );
  return row ? rowToSession(row) : null;
}

export async function listSessions(): Promise<Session[]> {
  const db = await getDB();
  const rows = await db.getAllAsync<SessionRow>(
    'SELECT * FROM sessions ORDER BY created_at DESC'
  );
  return rows.map(rowToSession);
}

export async function listSessionsWithPodcast(): Promise<Session[]> {
  const db = await getDB();
  const rows = await db.getAllAsync<SessionRow>(
    'SELECT * FROM sessions WHERE podcast_generated = 1 ORDER BY created_at DESC'
  );
  return rows.map(rowToSession);
}

export async function updateSession(
  id: string,
  patch: Partial<Omit<Session, 'id'>>
): Promise<void> {
  const sets: string[] = [];
  const values: SqlValue[] = [];

  if (patch.created_at !== undefined) {
    sets.push('created_at = ?');
    values.push(patch.created_at);
  }
  if (patch.photo_uri !== undefined) {
    sets.push('photo_uri = ?');
    values.push(toRelativeStoragePath(patch.photo_uri));
  }
  if (patch.photo_thumbnail_uri !== undefined) {
    sets.push('photo_thumbnail_uri = ?');
    values.push(toRelativeStoragePath(patch.photo_thumbnail_uri));
  }
  if (patch.recording_uri !== undefined) {
    sets.push('recording_uri = ?');
    values.push(toRelativeStoragePath(patch.recording_uri));
  }
  if (patch.transcript !== undefined) {
    sets.push('transcript = ?');
    values.push(patch.transcript);
  }
  if (patch.corrected_sentences !== undefined) {
    sets.push('corrected_sentences = ?');
    values.push(stringifyJson(patch.corrected_sentences));
  }
  if (patch.polished_sentences !== undefined) {
    sets.push('polished_sentences = ?');
    values.push(stringifyJson(patch.polished_sentences));
  }
  if (patch.sentence_audio_uris !== undefined) {
    sets.push('sentence_audio_uris = ?');
    values.push(
      stringifyJson(patch.sentence_audio_uris.map(toRelativeStoragePath))
    );
  }
  if (patch.chunks !== undefined) {
    sets.push('chunks = ?');
    values.push(stringifyJson(patch.chunks));
  }
  if (patch.chat_history !== undefined) {
    sets.push('chat_history = ?');
    values.push(stringifyJson(patch.chat_history));
  }
  if (patch.podcast_generated !== undefined) {
    sets.push('podcast_generated = ?');
    values.push(intFromBool(patch.podcast_generated));
  }
  if (patch.cards_generated !== undefined) {
    sets.push('cards_generated = ?');
    values.push(intFromBool(patch.cards_generated));
  }

  if (sets.length === 0) return;

  values.push(id);
  const db = await getDB();
  await db.runAsync(
    `UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`,
    values
  );
}

export async function deleteSession(id: string): Promise<void> {
  const db = await getDB();
  await db.runAsync('DELETE FROM sessions WHERE id = ?', [id]);
}
