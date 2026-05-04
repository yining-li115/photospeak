import {
  resolveStoragePath,
  toRelativeStoragePath,
} from '../storage/resolve';
import type { Card, ChunkExample, ReviewRecord } from '../types';
import { getDB, parseJsonArray, stringifyJson } from './schema';

type SqlValue = string | number | null;

interface CardRow {
  id: string;
  chunk_id: string;
  chunk: string;
  usage_note: string;
  examples: string;
  photo_thumbnail_uri: string;
  source_session_id: string;
  created_at: string;
  next_review_at: string;
  stability: number;
  difficulty: number;
  review_history: string;
}

function rowToCard(row: CardRow): Card {
  return {
    id: row.id,
    chunk_id: row.chunk_id,
    chunk: row.chunk,
    usage_note: row.usage_note,
    examples: parseJsonArray<ChunkExample>(row.examples),
    photo_thumbnail_uri: resolveStoragePath(row.photo_thumbnail_uri),
    source_session_id: row.source_session_id,
    created_at: row.created_at,
    next_review_at: row.next_review_at,
    stability: row.stability,
    difficulty: row.difficulty,
    review_history: parseJsonArray<ReviewRecord>(row.review_history),
  };
}

export async function createCard(c: Card): Promise<void> {
  const db = await getDB();
  await db.runAsync(
    `INSERT INTO cards (
      id, chunk_id, chunk, usage_note, examples,
      photo_thumbnail_uri, source_session_id, created_at, next_review_at,
      stability, difficulty, review_history
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      c.id,
      c.chunk_id,
      c.chunk,
      c.usage_note,
      stringifyJson(c.examples),
      toRelativeStoragePath(c.photo_thumbnail_uri),
      c.source_session_id,
      c.created_at,
      c.next_review_at,
      c.stability,
      c.difficulty,
      stringifyJson(c.review_history),
    ]
  );
}

export async function getCard(id: string): Promise<Card | null> {
  const db = await getDB();
  const row = await db.getFirstAsync<CardRow>(
    'SELECT * FROM cards WHERE id = ?',
    [id]
  );
  return row ? rowToCard(row) : null;
}

export async function listAllCards(): Promise<Card[]> {
  const db = await getDB();
  const rows = await db.getAllAsync<CardRow>(
    'SELECT * FROM cards ORDER BY created_at DESC'
  );
  return rows.map(rowToCard);
}

export async function listCardsDueBy(isoCutoff: string): Promise<Card[]> {
  const db = await getDB();
  const rows = await db.getAllAsync<CardRow>(
    'SELECT * FROM cards WHERE next_review_at <= ? ORDER BY next_review_at ASC',
    [isoCutoff]
  );
  return rows.map(rowToCard);
}

export async function listCardsBySession(
  sessionId: string
): Promise<Card[]> {
  const db = await getDB();
  const rows = await db.getAllAsync<CardRow>(
    'SELECT * FROM cards WHERE source_session_id = ? ORDER BY created_at ASC',
    [sessionId]
  );
  return rows.map(rowToCard);
}

export async function countCards(): Promise<number> {
  const db = await getDB();
  const row = await db.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) AS n FROM cards'
  );
  return row?.n ?? 0;
}

/**
 * Count cards considered "mastered" by FSRS stability. 21 days is the
 * common threshold for a card moving from learning into the mature
 * pool; stability is roughly the interval (in days) at which the
 * model expects ~90% recall.
 */
export async function countMasteredCards(
  thresholdDays: number = 21
): Promise<number> {
  const db = await getDB();
  const row = await db.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) AS n FROM cards WHERE stability >= ?',
    [thresholdDays]
  );
  return row?.n ?? 0;
}

export async function updateCard(
  id: string,
  patch: Partial<Omit<Card, 'id'>>
): Promise<void> {
  const sets: string[] = [];
  const values: SqlValue[] = [];

  if (patch.chunk_id !== undefined) {
    sets.push('chunk_id = ?');
    values.push(patch.chunk_id);
  }
  if (patch.chunk !== undefined) {
    sets.push('chunk = ?');
    values.push(patch.chunk);
  }
  if (patch.usage_note !== undefined) {
    sets.push('usage_note = ?');
    values.push(patch.usage_note);
  }
  if (patch.examples !== undefined) {
    sets.push('examples = ?');
    values.push(stringifyJson(patch.examples));
  }
  if (patch.photo_thumbnail_uri !== undefined) {
    sets.push('photo_thumbnail_uri = ?');
    values.push(toRelativeStoragePath(patch.photo_thumbnail_uri));
  }
  if (patch.source_session_id !== undefined) {
    sets.push('source_session_id = ?');
    values.push(patch.source_session_id);
  }
  if (patch.created_at !== undefined) {
    sets.push('created_at = ?');
    values.push(patch.created_at);
  }
  if (patch.next_review_at !== undefined) {
    sets.push('next_review_at = ?');
    values.push(patch.next_review_at);
  }
  if (patch.stability !== undefined) {
    sets.push('stability = ?');
    values.push(patch.stability);
  }
  if (patch.difficulty !== undefined) {
    sets.push('difficulty = ?');
    values.push(patch.difficulty);
  }
  if (patch.review_history !== undefined) {
    sets.push('review_history = ?');
    values.push(stringifyJson(patch.review_history));
  }

  if (sets.length === 0) return;

  values.push(id);
  const db = await getDB();
  await db.runAsync(
    `UPDATE cards SET ${sets.join(', ')} WHERE id = ?`,
    values
  );
}

export async function deleteCard(id: string): Promise<void> {
  const db = await getDB();
  await db.runAsync('DELETE FROM cards WHERE id = ?', [id]);
}

export async function deleteCardsBySession(sessionId: string): Promise<number> {
  const db = await getDB();
  const result = await db.runAsync(
    'DELETE FROM cards WHERE source_session_id = ?',
    [sessionId]
  );
  return result.changes ?? 0;
}
