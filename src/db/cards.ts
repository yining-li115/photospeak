import {
  resolveStoragePath,
  toRelativeStoragePath,
} from '../storage/resolve';
import { ensureDatabaseWriteCapacity } from '../storage/quota';
import type { Card, ChunkExample, ReviewRecord } from '../types';
import { requireCurrentOwner } from './owner';
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
  fsrs_elapsed_days: number;
  fsrs_scheduled_days: number;
  fsrs_learning_steps: number;
  fsrs_reps: number;
  fsrs_lapses: number;
  fsrs_state: number;
  fsrs_last_review_at: string | null;
}

export type CardReviewUpdate = Pick<
  Card,
  | 'next_review_at'
  | 'stability'
  | 'difficulty'
  | 'review_history'
  | 'fsrs_elapsed_days'
  | 'fsrs_scheduled_days'
  | 'fsrs_learning_steps'
  | 'fsrs_reps'
  | 'fsrs_lapses'
  | 'fsrs_state'
  | 'fsrs_last_review_at'
>;

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
    fsrs_elapsed_days: row.fsrs_elapsed_days,
    fsrs_scheduled_days: row.fsrs_scheduled_days,
    fsrs_learning_steps: row.fsrs_learning_steps,
    fsrs_reps: row.fsrs_reps,
    fsrs_lapses: row.fsrs_lapses,
    fsrs_state: normalizeFsrsState(row.fsrs_state),
    fsrs_last_review_at: row.fsrs_last_review_at,
    review_history: parseJsonArray<ReviewRecord>(row.review_history),
  };
}

export async function getCard(id: string): Promise<Card | null> {
  const owner = requireCurrentOwner();
  const db = await getDB();
  const row = await db.getFirstAsync<CardRow>(
    'SELECT * FROM cards WHERE owner_user_id = ? AND id = ?',
    [owner, id]
  );
  return row ? rowToCard(row) : null;
}

/** Pass a limit (for example 50) to keep review queues memory-bounded. */
export async function listCardsDueBy(
  isoCutoff: string,
  limit?: number
): Promise<Card[]> {
  const owner = requireCurrentOwner();
  const db = await getDB();
  const values: SqlValue[] = [owner, isoCutoff];
  const limitSql = limit === undefined ? '' : ' LIMIT ?';
  if (limit !== undefined) values.push(clampPageSize(limit));
  const rows = await db.getAllAsync<CardRow>(
    `SELECT * FROM cards
     WHERE owner_user_id = ? AND next_review_at <= ?
     ORDER BY next_review_at ASC, id ASC${limitSql}`,
    values
  );
  return rows.map(rowToCard);
}

export async function countCardsDueBy(isoCutoff: string): Promise<number> {
  const owner = requireCurrentOwner();
  const db = await getDB();
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM cards
     WHERE owner_user_id = ? AND next_review_at <= ?`,
    [owner, isoCutoff]
  );
  return row?.n ?? 0;
}

export async function listCardsBySession(
  sessionId: string
): Promise<Card[]> {
  const owner = requireCurrentOwner();
  const db = await getDB();
  const rows = await db.getAllAsync<CardRow>(
    `SELECT * FROM cards
     WHERE owner_user_id = ? AND source_session_id = ?
     ORDER BY created_at ASC, id ASC`,
    [owner, sessionId]
  );
  return rows.map(rowToCard);
}

export async function countCardsBySession(sessionId: string): Promise<number> {
  const owner = requireCurrentOwner();
  const db = await getDB();
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM cards
     WHERE owner_user_id = ? AND source_session_id = ?`,
    [owner, sessionId]
  );
  return row?.n ?? 0;
}

export async function countCards(): Promise<number> {
  const owner = requireCurrentOwner();
  const db = await getDB();
  const row = await db.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) AS n FROM cards WHERE owner_user_id = ?',
    [owner]
  );
  return row?.n ?? 0;
}

/**
 * Count cards considered mature by FSRS stability. Stability is approximately
 * the interval (days) at which the scheduler expects 90% recall.
 */
export async function countMasteredCards(
  thresholdDays: number = 21
): Promise<number> {
  const owner = requireCurrentOwner();
  const db = await getDB();
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM cards
     WHERE owner_user_id = ? AND stability >= ?`,
    [owner, thresholdDays]
  );
  return row?.n ?? 0;
}

/**
 * Persist a review, its immutable event, and daily stats in one transaction.
 * expectedLastReviewAt is an optimistic-concurrency token from the card shown
 * to the user; a stale/double submission is rejected instead of counted twice.
 */
export async function commitCardReview(
  id: string,
  update: CardReviewUpdate,
  localDate: string,
  expectedLastReviewAt: string | null
): Promise<void> {
  const owner = requireCurrentOwner();
  const latest = update.review_history[update.review_history.length - 1];
  if (!latest || latest.date !== update.fsrs_last_review_at) {
    throw new Error('Review update is missing its latest review event');
  }
  ensureDatabaseWriteCapacity([id, update, localDate]);

  const db = await getDB();
  await db.withExclusiveTransactionAsync(async (txn) => {
    const result = await txn.runAsync(
      `UPDATE cards SET
         next_review_at = ?, stability = ?, difficulty = ?, review_history = ?,
         fsrs_elapsed_days = ?, fsrs_scheduled_days = ?,
         fsrs_learning_steps = ?, fsrs_reps = ?, fsrs_lapses = ?,
         fsrs_state = ?, fsrs_last_review_at = ?
       WHERE owner_user_id = ? AND id = ? AND fsrs_last_review_at IS ?`,
      [
        update.next_review_at,
        update.stability,
        update.difficulty,
        stringifyJson(update.review_history),
        update.fsrs_elapsed_days,
        update.fsrs_scheduled_days,
        update.fsrs_learning_steps,
        update.fsrs_reps,
        update.fsrs_lapses,
        update.fsrs_state,
        update.fsrs_last_review_at,
        owner,
        id,
        expectedLastReviewAt,
      ]
    );
    if (result.changes !== 1) {
      throw new Error('This card was already reviewed; reload before retrying');
    }

    await txn.runAsync(
      `INSERT INTO card_review_events (
         owner_user_id, card_id, reviewed_at, rating, next_review_at,
         stability, difficulty, fsrs_elapsed_days, fsrs_scheduled_days,
         fsrs_learning_steps, fsrs_reps, fsrs_lapses, fsrs_state
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        owner,
        id,
        latest.date,
        latest.rating,
        update.next_review_at,
        update.stability,
        update.difficulty,
        update.fsrs_elapsed_days,
        update.fsrs_scheduled_days,
        update.fsrs_learning_steps,
        update.fsrs_reps,
        update.fsrs_lapses,
        update.fsrs_state,
      ]
    );
    await txn.runAsync(
      `INSERT INTO stats (owner_user_id, date, cards_reviewed)
       VALUES (?, ?, 1)
       ON CONFLICT(owner_user_id, date) DO UPDATE SET
         cards_reviewed = cards_reviewed + 1`,
      [owner, localDate]
    );
  });
}

export function cardValues(owner: string, c: Card): SqlValue[] {
  return [
    owner,
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
    c.fsrs_elapsed_days,
    c.fsrs_scheduled_days,
    c.fsrs_learning_steps,
    c.fsrs_reps,
    c.fsrs_lapses,
    c.fsrs_state,
    c.fsrs_last_review_at,
  ];
}

function normalizeFsrsState(value: number): 0 | 1 | 2 | 3 {
  return value === 1 || value === 2 || value === 3 ? value : 0;
}

function clampPageSize(limit: number): number {
  if (!Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(200, Math.floor(limit)));
}
