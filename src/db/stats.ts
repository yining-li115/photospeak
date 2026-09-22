import type { DailyStats } from '../types';
import { previousDateKey } from '../utils/local-date';
import { requireCurrentOwner } from './owner';
import { getDB } from './schema';

interface StatsRow {
  date: string;
  session_count: number;
  listening_seconds: number;
  cards_reviewed: number;
}

const ZERO_STATS = (date: string): DailyStats => ({
  date,
  session_count: 0,
  listening_seconds: 0,
  cards_reviewed: 0,
});

export async function getDailyStats(date: string): Promise<DailyStats> {
  const owner = requireCurrentOwner();
  const db = await getDB();
  const row = await db.getFirstAsync<StatsRow>(
    'SELECT date, session_count, listening_seconds, cards_reviewed FROM stats WHERE owner_user_id = ? AND date = ?',
    [owner, date]
  );
  return row ?? ZERO_STATS(date);
}

export async function incrementSessionCount(date: string): Promise<void> {
  const owner = requireCurrentOwner();
  const db = await getDB();
  await db.runAsync(
    `INSERT INTO stats (owner_user_id, date, session_count) VALUES (?, ?, 1)
     ON CONFLICT(owner_user_id, date) DO UPDATE SET session_count = session_count + 1`,
    [owner, date]
  );
}

export async function addListeningSeconds(
  date: string,
  seconds: number
): Promise<void> {
  const owner = requireCurrentOwner();
  await addListeningSecondsForOwner(owner, date, seconds);
}

/** Attribute a late player cleanup to its captured account, never a new one. */
export async function addListeningSecondsForOwner(
  owner: string,
  date: string,
  seconds: number
): Promise<void> {
  if (!owner.trim() || owner === '__legacy__') return;
  const db = await getDB();
  await db.runAsync(
    `INSERT INTO stats (owner_user_id, date, listening_seconds) VALUES (?, ?, ?)
     ON CONFLICT(owner_user_id, date) DO UPDATE SET listening_seconds = listening_seconds + ?`,
    [owner, date, seconds, seconds]
  );
}

export async function incrementCardsReviewed(date: string): Promise<void> {
  const owner = requireCurrentOwner();
  const db = await getDB();
  await db.runAsync(
    `INSERT INTO stats (owner_user_id, date, cards_reviewed) VALUES (?, ?, 1)
     ON CONFLICT(owner_user_id, date) DO UPDATE SET cards_reviewed = cards_reviewed + 1`,
    [owner, date]
  );
}

export async function getStatsRange(
  startDate: string,
  endDate: string
): Promise<DailyStats[]> {
  const owner = requireCurrentOwner();
  const db = await getDB();
  const rows = await db.getAllAsync<StatsRow>(
    `SELECT date, session_count, listening_seconds, cards_reviewed FROM stats
     WHERE owner_user_id = ? AND date >= ? AND date <= ? ORDER BY date ASC`,
    [owner, startDate, endDate]
  );
  return rows;
}

export async function getCurrentStreak(today: string): Promise<number> {
  const owner = requireCurrentOwner();
  const db = await getDB();
  const rows = await db.getAllAsync<{ date: string }>(
    `SELECT date FROM stats
     WHERE owner_user_id = ? AND session_count > 0 ORDER BY date DESC`,
    [owner]
  );
  const active = new Set(rows.map((r) => r.date));

  let streak = 0;
  let cursor = today;
  while (active.has(cursor)) {
    streak += 1;
    cursor = previousDateKey(cursor);
  }
  return streak;
}

export async function getTotalListeningSeconds(): Promise<number> {
  const owner = requireCurrentOwner();
  const db = await getDB();
  const row = await db.getFirstAsync<{ total: number | null }>(
    'SELECT SUM(listening_seconds) AS total FROM stats WHERE owner_user_id = ?',
    [owner]
  );
  return row?.total ?? 0;
}

export async function getListeningSecondsBetween(
  startDate: string,
  endDate: string
): Promise<number> {
  const owner = requireCurrentOwner();
  const db = await getDB();
  const row = await db.getFirstAsync<{ total: number | null }>(
    `SELECT SUM(listening_seconds) AS total FROM stats
     WHERE owner_user_id = ? AND date >= ? AND date <= ?`,
    [owner, startDate, endDate]
  );
  return row?.total ?? 0;
}
