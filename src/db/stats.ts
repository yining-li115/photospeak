import type { DailyStats } from '../types';
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
  const db = await getDB();
  const row = await db.getFirstAsync<StatsRow>(
    'SELECT * FROM stats WHERE date = ?',
    [date]
  );
  return row ?? ZERO_STATS(date);
}

export async function incrementSessionCount(date: string): Promise<void> {
  const db = await getDB();
  await db.runAsync(
    `INSERT INTO stats (date, session_count) VALUES (?, 1)
     ON CONFLICT(date) DO UPDATE SET session_count = session_count + 1`,
    [date]
  );
}

export async function addListeningSeconds(
  date: string,
  seconds: number
): Promise<void> {
  const db = await getDB();
  await db.runAsync(
    `INSERT INTO stats (date, listening_seconds) VALUES (?, ?)
     ON CONFLICT(date) DO UPDATE SET listening_seconds = listening_seconds + ?`,
    [date, seconds, seconds]
  );
}

export async function incrementCardsReviewed(date: string): Promise<void> {
  const db = await getDB();
  await db.runAsync(
    `INSERT INTO stats (date, cards_reviewed) VALUES (?, 1)
     ON CONFLICT(date) DO UPDATE SET cards_reviewed = cards_reviewed + 1`,
    [date]
  );
}

export async function getStatsRange(
  startDate: string,
  endDate: string
): Promise<DailyStats[]> {
  const db = await getDB();
  const rows = await db.getAllAsync<StatsRow>(
    'SELECT * FROM stats WHERE date >= ? AND date <= ? ORDER BY date ASC',
    [startDate, endDate]
  );
  return rows;
}

export async function getCurrentStreak(today: string): Promise<number> {
  const db = await getDB();
  const rows = await db.getAllAsync<{ date: string }>(
    'SELECT date FROM stats WHERE session_count > 0'
  );
  const active = new Set(rows.map((r) => r.date));

  let streak = 0;
  let cursor = today;
  while (active.has(cursor)) {
    streak += 1;
    cursor = subtractOneDay(cursor);
  }
  return streak;
}

export async function getTotalListeningSeconds(): Promise<number> {
  const db = await getDB();
  const row = await db.getFirstAsync<{ total: number | null }>(
    'SELECT SUM(listening_seconds) AS total FROM stats'
  );
  return row?.total ?? 0;
}

export async function getListeningSecondsBetween(
  startDate: string,
  endDate: string
): Promise<number> {
  const db = await getDB();
  const row = await db.getFirstAsync<{ total: number | null }>(
    `SELECT SUM(listening_seconds) AS total FROM stats
     WHERE date >= ? AND date <= ?`,
    [startDate, endDate]
  );
  return row?.total ?? 0;
}

function subtractOneDay(date: string): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
