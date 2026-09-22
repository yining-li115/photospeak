import {
  resolveStoragePath,
  toRelativeStoragePath,
} from '../storage/resolve';
import { ensureDatabaseWriteCapacity } from '../storage/quota';
import type {
  ChatMessage,
  Chunk,
  CorrectedSentence,
  Session,
} from '../types';
import { requireCurrentOwner } from './owner';
import {
  boolFromInt,
  getDB,
  intFromBool,
  parseJsonArray,
  stringifyJson,
} from './schema';

type SqlValue = string | number | null;
const DEFAULT_CHAT_PAGE_SIZE = 100;
const MAX_CHAT_PAGE_SIZE = 200;
const MAX_STORED_CHAT_CHARS = 8_000;

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

interface SessionFilesRow {
  id: string;
  photo_uri: string;
  photo_thumbnail_uri: string;
  recording_uri: string;
  sentence_audio_uris: string | null;
}

interface SessionSummaryRow {
  id: string;
  created_at: string;
  photo_thumbnail_uri: string;
  summary_title: string;
  sentence_count: number;
  podcast_generated: number;
  cards_generated: number;
}

export interface SessionSummary {
  id: string;
  created_at: string;
  photo_thumbnail_uri: string;
  summary_title: string;
  sentence_count: number;
  podcast_generated: boolean;
  cards_generated: boolean;
}

export interface SessionCursor {
  createdAt: string;
  id: string;
}

export interface SessionPage {
  items: SessionSummary[];
  nextCursor: SessionCursor | null;
}

export interface ListSessionSummariesOptions {
  limit?: number;
  cursor?: SessionCursor;
  podcastOnly?: boolean;
}

export interface SessionStorageFiles {
  id: string;
  photoUri: string;
  photoThumbnailUri: string;
  recordingUri: string;
  sentenceAudioUris: string[];
}

function rowToSession(
  row: SessionRow,
  chatHistory: ChatMessage[] = []
): Session {
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
    chat_history: chatHistory,
    podcast_generated: boolFromInt(row.podcast_generated),
    cards_generated: boolFromInt(row.cards_generated),
  };
}

function rowToSummary(row: SessionSummaryRow): SessionSummary {
  return {
    id: row.id,
    created_at: row.created_at,
    photo_thumbnail_uri: resolveStoragePath(row.photo_thumbnail_uri),
    summary_title: row.summary_title,
    sentence_count: row.sentence_count,
    podcast_generated: boolFromInt(row.podcast_generated),
    cards_generated: boolFromInt(row.cards_generated),
  };
}

function rowToStorageFiles(row: SessionFilesRow): SessionStorageFiles {
  return {
    id: row.id,
    photoUri: resolveStoragePath(row.photo_uri),
    photoThumbnailUri: resolveStoragePath(row.photo_thumbnail_uri),
    recordingUri: resolveStoragePath(row.recording_uri),
    sentenceAudioUris: parseJsonArray<string>(row.sentence_audio_uris).map(
      resolveStoragePath
    ),
  };
}

export async function getSession(
  id: string,
  options: { chatLimit?: number } = {}
): Promise<Session | null> {
  const owner = requireCurrentOwner();
  const db = await getDB();
  const row = await db.getFirstAsync<SessionRow>(
    `SELECT * FROM sessions
     WHERE owner_user_id = ? AND id = ? AND generation_status = 'ready'`,
    [owner, id]
  );
  if (!row) return null;
  const chatLimit = options.chatLimit ?? DEFAULT_CHAT_PAGE_SIZE;
  return rowToSession(
    row,
    chatLimit > 0 ? await listSessionChatMessages(id, chatLimit) : []
  );
}

/**
 * Cursor-paged list projection. It never parses transcripts, chat, chunks or
 * audio arrays, so list memory stays bounded as a user's history grows.
 */
export async function listSessionSummaries(
  options: ListSessionSummariesOptions = {}
): Promise<SessionPage> {
  const owner = requireCurrentOwner();
  const db = await getDB();
  const limit = clampPageSize(options.limit);
  const predicates = [
    'owner_user_id = ?',
    "generation_status = 'ready'",
  ];
  const values: SqlValue[] = [owner];

  if (options.podcastOnly) predicates.push('podcast_generated = 1');
  if (options.cursor) {
    predicates.push('(created_at < ? OR (created_at = ? AND id < ?))');
    values.push(
      options.cursor.createdAt,
      options.cursor.createdAt,
      options.cursor.id
    );
  }
  values.push(limit + 1);

  const rows = await db.getAllAsync<SessionSummaryRow>(
    `SELECT id, created_at, photo_thumbnail_uri, summary_title,
            sentence_count, podcast_generated, cards_generated
     FROM sessions
     WHERE ${predicates.join(' AND ')}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    values
  );

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map(rowToSummary),
    nextCursor:
      hasMore && last ? { createdAt: last.created_at, id: last.id } : null,
  };
}

export async function countSessions(podcastOnly = false): Promise<number> {
  const owner = requireCurrentOwner();
  const db = await getDB();
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sessions
     WHERE owner_user_id = ? AND generation_status = 'ready'
       ${podcastOnly ? 'AND podcast_generated = 1' : ''}`,
    [owner]
  );
  return row?.n ?? 0;
}

/**
 * Read only the newest bounded page. Messages remain normalized in SQLite, so
 * a future “load earlier” UI can page backwards without parsing one giant JSON
 * field or loading the whole conversation into React Native memory.
 */
export async function listSessionChatMessages(
  id: string,
  limit = DEFAULT_CHAT_PAGE_SIZE
): Promise<ChatMessage[]> {
  const owner = requireCurrentOwner();
  const db = await getDB();
  const boundedLimit = Math.max(
    1,
    Math.min(MAX_CHAT_PAGE_SIZE, Math.floor(limit) || DEFAULT_CHAT_PAGE_SIZE)
  );
  const rows = await db.getAllAsync<ChatMessage & { sequence: number }>(
    `SELECT role, content, timestamp, sequence
     FROM (
       SELECT role, content, timestamp, sequence
       FROM session_chat_messages
       WHERE owner_user_id = ? AND session_id = ?
       ORDER BY sequence DESC
       LIMIT ?
     )
     ORDER BY sequence ASC`,
    [owner, id, boundedLimit]
  );
  return rows.map(({ role, content, timestamp }) => ({
    role,
    content,
    timestamp,
  }));
}

/** Append a successful user/assistant exchange as one local transaction. */
export async function appendSessionChatMessages(
  id: string,
  messages: readonly ChatMessage[]
): Promise<void> {
  if (messages.length === 0) return;
  const normalized = normalizeChatMessages(messages);
  if (normalized.length === 0) return;
  ensureDatabaseWriteCapacity([id, normalized]);
  const owner = requireCurrentOwner();
  const db = await getDB();
  await db.withExclusiveTransactionAsync(async (txn) => {
    const session = await txn.getFirstAsync<{ present: number }>(
      `SELECT 1 AS present FROM sessions
       WHERE owner_user_id = ? AND id = ? AND generation_status = 'ready'`,
      [owner, id]
    );
    if (!session) throw new Error('Session no longer exists');
    const last = await txn.getFirstAsync<{ sequence: number | null }>(
      `SELECT MAX(sequence) AS sequence FROM session_chat_messages
       WHERE owner_user_id = ? AND session_id = ?`,
      [owner, id]
    );
    let sequence = (last?.sequence ?? -1) + 1;
    for (const message of normalized) {
      await txn.runAsync(
        `INSERT INTO session_chat_messages (
           owner_user_id, session_id, sequence, role, content, timestamp
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [owner, id, sequence++, message.role, message.content, message.timestamp]
      );
    }
    await txn.runAsync(
      `UPDATE sessions SET updated_at = ?
       WHERE owner_user_id = ? AND id = ?`,
      [new Date().toISOString(), owner, id]
    );
  });
}

export async function deleteSession(id: string): Promise<void> {
  const owner = requireCurrentOwner();
  const db = await getDB();
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      'DELETE FROM ai_operation_intents WHERE owner_user_id = ? AND session_id = ?',
      [owner, id]
    );
    await txn.runAsync(
      'DELETE FROM sessions WHERE owner_user_id = ? AND id = ?',
      [owner, id]
    );
  });
}

/** Delete one owner's DB graph atomically and return files for best-effort GC. */
export async function deleteSessionRows(
  id: string
): Promise<SessionStorageFiles | null> {
  const owner = requireCurrentOwner();
  const db = await getDB();
  let files: SessionStorageFiles | null = null;
  await db.withExclusiveTransactionAsync(async (txn) => {
    const row = await txn.getFirstAsync<SessionFilesRow>(
      `SELECT id, photo_uri, photo_thumbnail_uri, recording_uri,
              sentence_audio_uris
       FROM sessions WHERE owner_user_id = ? AND id = ?`,
      [owner, id]
    );
    if (!row) {
      await txn.runAsync(
        'DELETE FROM ai_operation_intents WHERE owner_user_id = ? AND session_id = ?',
        [owner, id]
      );
      return;
    }
    files = rowToStorageFiles(row);
    await txn.runAsync(
      'DELETE FROM cards WHERE owner_user_id = ? AND source_session_id = ?',
      [owner, id]
    );
    await txn.runAsync(
      'DELETE FROM ai_operation_intents WHERE owner_user_id = ? AND session_id = ?',
      [owner, id]
    );
    await txn.runAsync(
      'DELETE FROM sessions WHERE owner_user_id = ? AND id = ?',
      [owner, id]
    );
  });
  return files;
}

/** Remove all rows for account deletion while preserving other local users. */
export async function deleteCurrentOwnerRows(): Promise<
  SessionStorageFiles[]
> {
  return deleteOwnerRows(requireCurrentOwner());
}

/** Read the complete media manifest before an account-deletion purge. */
export async function listOwnerStorageFiles(
  owner: string
): Promise<SessionStorageFiles[]> {
  if (!owner.trim() || owner === '__legacy__') {
    throw new Error('Invalid owner for local deletion');
  }
  const db = await getDB();
  const rows = await db.getAllAsync<SessionFilesRow>(
    `SELECT id, photo_uri, photo_thumbnail_uri, recording_uri,
            sentence_audio_uris
     FROM sessions WHERE owner_user_id = ?`,
    [owner]
  );
  return rows.map(rowToStorageFiles);
}

/** Retry-safe variant used by persisted account-deletion tombstones. */
export async function deleteOwnerRows(
  owner: string
): Promise<SessionStorageFiles[]> {
  if (!owner.trim() || owner === '__legacy__') {
    throw new Error('Invalid owner for local deletion');
  }
  const db = await getDB();
  let files: SessionStorageFiles[] = [];
  await db.withExclusiveTransactionAsync(async (txn) => {
    const rows = await txn.getAllAsync<SessionFilesRow>(
      `SELECT id, photo_uri, photo_thumbnail_uri, recording_uri,
              sentence_audio_uris
       FROM sessions WHERE owner_user_id = ?`,
      [owner]
    );
    files = rows.map(rowToStorageFiles);
    await txn.runAsync(
      'DELETE FROM ai_operation_intents WHERE owner_user_id = ?',
      [owner]
    );
    await txn.runAsync('DELETE FROM cards WHERE owner_user_id = ?', [owner]);
    await txn.runAsync('DELETE FROM sessions WHERE owner_user_id = ?', [owner]);
    await txn.runAsync('DELETE FROM stats WHERE owner_user_id = ?', [owner]);
  });
  return files;
}

/** Internal maintenance projection; returns no user text or identity. */
export async function listAllReferencedStoragePaths(options: {
  /**
   * Old completed TTS drafts without a session stop pinning media after this
   * timestamp. The janitor still deletes their DB rows only after the file.
   */
  abandonedSpeechIntentCutoff?: string;
} = {}): Promise<Set<string>> {
  const db = await getDB();
  const rows = await db.getAllAsync<Omit<SessionFilesRow, 'id'>>(
    `SELECT photo_uri, photo_thumbnail_uri, recording_uri, sentence_audio_uris
     FROM sessions`
  );
  const intentRows = await db.getAllAsync<{ local_result_uri: string | null }>(
    `SELECT intent.local_result_uri FROM ai_operation_intents AS intent
     WHERE intent.local_result_uri IS NOT NULL
       ${
         options.abandonedSpeechIntentCutoff
           ? `AND NOT (
                intent.capability = 'speech_synthesis'
                AND intent.state = 'completed'
                AND intent.updated_at <= ?
                AND NOT EXISTS (
                  SELECT 1 FROM sessions AS session
                  WHERE session.owner_user_id = intent.owner_user_id
                    AND session.id = intent.session_id
                )
              )`
           : ''
       }`,
    options.abandonedSpeechIntentCutoff
      ? [options.abandonedSpeechIntentCutoff]
      : []
  );
  const paths = new Set<string>();
  for (const row of rows) {
    for (const path of [
      row.photo_uri,
      row.photo_thumbnail_uri,
      row.recording_uri,
      ...parseJsonArray<string>(row.sentence_audio_uris),
    ]) {
      if (path) paths.add(toRelativeStoragePath(path));
    }
  }
  for (const row of intentRows) {
    if (row.local_result_uri) {
      paths.add(toRelativeStoragePath(row.local_result_uri));
    }
  }
  return paths;
}

/** Prevent a cross-account UUID collision from overwriting another user's files. */
export async function assertSessionIdAvailable(id: string): Promise<void> {
  const owner = requireCurrentOwner();
  const db = await getDB();
  const row = await db.getFirstAsync<{ owner_user_id: string }>(
    'SELECT owner_user_id FROM sessions WHERE id = ?',
    [id]
  );
  if (row && row.owner_user_id !== owner) {
    throw new Error('Session identifier is already in use');
  }
}

export function sessionValues(
  owner: string,
  s: Session,
  updatedAt: string
): SqlValue[] {
  return [
    owner,
    s.id,
    s.created_at,
    updatedAt,
    toRelativeStoragePath(s.photo_uri),
    toRelativeStoragePath(s.photo_thumbnail_uri),
    toRelativeStoragePath(s.recording_uri),
    s.transcript,
    stringifyJson(s.corrected_sentences),
    stringifyJson(s.polished_sentences),
    stringifyJson(s.sentence_audio_uris.map(toRelativeStoragePath)),
    stringifyJson(s.chunks),
    // V3 stores chat rows in session_chat_messages. Keep the legacy column
    // empty so old code paths can never recreate an unbounded JSON blob.
    null,
    s.chunks[0]?.chunk ?? '',
    s.polished_sentences.length,
    intFromBool(s.podcast_generated),
    intFromBool(s.cards_generated),
  ];
}

export function normalizeChatMessages(
  messages: readonly ChatMessage[]
): ChatMessage[] {
  const fallbackTimestamp = new Date().toISOString();
  const normalized: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const content = message.content.trim().slice(0, MAX_STORED_CHAT_CHARS);
    if (!content) continue;
    const candidate = new Date(message.timestamp);
    normalized.push({
      role: message.role,
      content,
      timestamp: Number.isNaN(candidate.getTime())
        ? fallbackTimestamp
        : candidate.toISOString(),
    });
  }
  return normalized;
}

function clampPageSize(limit = 30): number {
  if (!Number.isFinite(limit)) return 30;
  return Math.max(1, Math.min(100, Math.floor(limit)));
}
