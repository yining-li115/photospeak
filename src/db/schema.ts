import * as SQLite from 'expo-sqlite';

const DB_NAME = 'photospeak.db';
const SCHEMA_VERSION = 1;

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    photo_uri TEXT NOT NULL,
    photo_thumbnail_uri TEXT NOT NULL,
    recording_uri TEXT NOT NULL,
    transcript TEXT,
    corrected_sentences TEXT,
    polished_sentences TEXT,
    sentence_audio_uris TEXT,
    chunks TEXT,
    chat_history TEXT,
    podcast_generated INTEGER NOT NULL DEFAULT 0,
    cards_generated INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_created_at
    ON sessions(created_at DESC);

  CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    chunk_id TEXT NOT NULL,
    chunk TEXT NOT NULL,
    usage_note TEXT NOT NULL,
    examples TEXT NOT NULL,
    photo_thumbnail_uri TEXT NOT NULL,
    source_session_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    next_review_at TEXT NOT NULL,
    stability REAL NOT NULL DEFAULT 0,
    difficulty REAL NOT NULL DEFAULT 0,
    review_history TEXT NOT NULL DEFAULT '[]'
  );

  CREATE INDEX IF NOT EXISTS idx_cards_next_review_at
    ON cards(next_review_at);

  CREATE INDEX IF NOT EXISTS idx_cards_source_session_id
    ON cards(source_session_id);

  CREATE TABLE IF NOT EXISTS stats (
    date TEXT PRIMARY KEY,
    session_count INTEGER NOT NULL DEFAULT 0,
    listening_seconds INTEGER NOT NULL DEFAULT 0,
    cards_reviewed INTEGER NOT NULL DEFAULT 0
  );
`;

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDB(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync(DB_NAME);
      await migrate(db);
      return db;
    })();
  }
  return dbPromise;
}

async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>(
    'PRAGMA user_version'
  );
  const current = row?.user_version ?? 0;
  if (current < 1) {
    await db.execAsync(SCHEMA_V1);
  }
  if (current !== SCHEMA_VERSION) {
    await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
}

export function parseJsonArray<T>(s: string | null): T[] {
  return s ? (JSON.parse(s) as T[]) : [];
}

export function stringifyJson(v: unknown): string {
  return JSON.stringify(v);
}

export function boolFromInt(n: number): boolean {
  return n !== 0;
}

export function intFromBool(b: boolean): number {
  return b ? 1 : 0;
}
