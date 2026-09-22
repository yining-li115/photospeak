import * as SQLite from 'expo-sqlite';

const DB_NAME = 'photospeak.db';
const SCHEMA_VERSION = 7;

/**
 * V1 stays compatible with the database that shipped in the beta. New installs
 * run every migration in order, just like upgraded installs, so there is only
 * one migration path to test.
 */
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

/**
 * V2 scopes every user-owned row, adds cheap list metadata, and persists the
 * complete ts-fsrs state. Existing beta rows enter a quarantine owner and are
 * imported only after explicit user confirmation (owner.ts).
 */
const SCHEMA_V2 = `
  ALTER TABLE sessions RENAME TO sessions_v1;
  ALTER TABLE cards RENAME TO cards_v1;
  ALTER TABLE stats RENAME TO stats_v1;

  CREATE TABLE sessions (
    owner_user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    photo_uri TEXT NOT NULL,
    photo_thumbnail_uri TEXT NOT NULL,
    recording_uri TEXT NOT NULL,
    transcript TEXT,
    corrected_sentences TEXT,
    polished_sentences TEXT,
    sentence_audio_uris TEXT,
    chunks TEXT,
    chat_history TEXT,
    summary_title TEXT NOT NULL DEFAULT '',
    sentence_count INTEGER NOT NULL DEFAULT 0,
    podcast_generated INTEGER NOT NULL DEFAULT 0,
    cards_generated INTEGER NOT NULL DEFAULT 0,
    generation_status TEXT NOT NULL DEFAULT 'ready'
      CHECK (generation_status IN ('processing', 'ready', 'failed')),
    generation_error TEXT,
    PRIMARY KEY (owner_user_id, id),
    UNIQUE (id)
  );

  CREATE TABLE cards (
    owner_user_id TEXT NOT NULL,
    id TEXT NOT NULL,
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
    review_history TEXT NOT NULL DEFAULT '[]',
    fsrs_elapsed_days INTEGER NOT NULL DEFAULT 0,
    fsrs_scheduled_days INTEGER NOT NULL DEFAULT 0,
    fsrs_learning_steps INTEGER NOT NULL DEFAULT 0,
    fsrs_reps INTEGER NOT NULL DEFAULT 0,
    fsrs_lapses INTEGER NOT NULL DEFAULT 0,
    fsrs_state INTEGER NOT NULL DEFAULT 0 CHECK (fsrs_state BETWEEN 0 AND 3),
    fsrs_last_review_at TEXT,
    PRIMARY KEY (owner_user_id, id),
    UNIQUE (id),
    FOREIGN KEY (owner_user_id, source_session_id)
      REFERENCES sessions(owner_user_id, id) ON DELETE CASCADE
  );

  CREATE TABLE card_review_events (
    owner_user_id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    reviewed_at TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4),
    next_review_at TEXT NOT NULL,
    stability REAL NOT NULL,
    difficulty REAL NOT NULL,
    fsrs_elapsed_days INTEGER NOT NULL,
    fsrs_scheduled_days INTEGER NOT NULL,
    fsrs_learning_steps INTEGER NOT NULL,
    fsrs_reps INTEGER NOT NULL,
    fsrs_lapses INTEGER NOT NULL,
    fsrs_state INTEGER NOT NULL CHECK (fsrs_state BETWEEN 0 AND 3),
    PRIMARY KEY (owner_user_id, card_id, reviewed_at),
    FOREIGN KEY (owner_user_id, card_id)
      REFERENCES cards(owner_user_id, id) ON DELETE CASCADE
  );

  CREATE TABLE stats (
    owner_user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    session_count INTEGER NOT NULL DEFAULT 0,
    listening_seconds INTEGER NOT NULL DEFAULT 0,
    cards_reviewed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_user_id, date)
  );

  INSERT INTO sessions (
    owner_user_id, id, created_at, updated_at, photo_uri,
    photo_thumbnail_uri, recording_uri, transcript, corrected_sentences,
    polished_sentences, sentence_audio_uris, chunks, chat_history,
    summary_title, sentence_count, podcast_generated, cards_generated,
    generation_status, generation_error
  )
  SELECT
    '__legacy__', id, created_at, created_at, photo_uri,
    photo_thumbnail_uri, recording_uri, transcript, corrected_sentences,
    polished_sentences, sentence_audio_uris, chunks, chat_history,
    CASE
      WHEN json_valid(chunks)
      THEN CASE
        WHEN json_type(chunks) = 'array'
             AND json_array_length(chunks) > 0
        THEN COALESCE(json_extract(chunks, '$[0].chunk'), '')
        ELSE ''
      END
      ELSE ''
    END,
    CASE
      WHEN json_valid(polished_sentences)
      THEN CASE
        WHEN json_type(polished_sentences) = 'array'
        THEN COALESCE(json_array_length(polished_sentences), 0)
        ELSE 0
      END
      ELSE 0
    END,
    podcast_generated, cards_generated, 'ready', NULL
  FROM sessions_v1;

  INSERT INTO cards (
    owner_user_id, id, chunk_id, chunk, usage_note, examples,
    photo_thumbnail_uri, source_session_id, created_at, next_review_at,
    stability, difficulty, review_history, fsrs_elapsed_days,
    fsrs_scheduled_days, fsrs_learning_steps, fsrs_reps, fsrs_lapses,
    fsrs_state, fsrs_last_review_at
  )
  SELECT
    '__legacy__', c.id, c.chunk_id, c.chunk, c.usage_note, c.examples,
    c.photo_thumbnail_uri, c.source_session_id, c.created_at, c.next_review_at,
    c.stability, c.difficulty,
    CASE
      WHEN json_valid(c.review_history)
      THEN CASE
        WHEN json_type(c.review_history) = 'array' THEN c.review_history
        ELSE '[]'
      END
      ELSE '[]'
    END,
    0,
    CASE
      WHEN json_valid(c.review_history)
      THEN CASE
        WHEN json_type(c.review_history) = 'array'
             AND json_array_length(c.review_history) > 0
        THEN COALESCE(MAX(0, CAST(
          julianday(c.next_review_at) - julianday(
            json_extract(c.review_history, '$[#-1].date')
          ) AS INTEGER
        )), 0)
        ELSE 0
      END
      ELSE 0
    END,
    0,
    CASE
      WHEN json_valid(c.review_history)
      THEN CASE
        WHEN json_type(c.review_history) = 'array'
        THEN COALESCE(json_array_length(c.review_history), 0)
        ELSE 0
      END
      ELSE 0
    END,
    0,
    CASE WHEN c.stability > 0 THEN 2 ELSE 0 END,
    CASE
      WHEN json_valid(c.review_history)
      THEN CASE
        WHEN json_type(c.review_history) = 'array'
             AND json_array_length(c.review_history) > 0
        THEN json_extract(c.review_history, '$[#-1].date')
        ELSE NULL
      END
      ELSE NULL
    END
  FROM cards_v1 c
  WHERE EXISTS (
    SELECT 1 FROM sessions_v1 s WHERE s.id = c.source_session_id
  );

  INSERT INTO stats (
    owner_user_id, date, session_count, listening_seconds, cards_reviewed
  )
  SELECT
    '__legacy__', date, session_count, listening_seconds, cards_reviewed
  FROM stats_v1;

  DROP TABLE cards_v1;
  DROP TABLE sessions_v1;
  DROP TABLE stats_v1;

  CREATE INDEX idx_sessions_owner_created
    ON sessions(owner_user_id, generation_status, created_at DESC, id DESC);
  CREATE INDEX idx_sessions_owner_podcast
    ON sessions(owner_user_id, podcast_generated, generation_status, created_at DESC);
  CREATE INDEX idx_cards_owner_due
    ON cards(owner_user_id, next_review_at, id);
  CREATE INDEX idx_cards_owner_session
    ON cards(owner_user_id, source_session_id, created_at);
  CREATE INDEX idx_card_review_events_owner_date
    ON card_review_events(owner_user_id, reviewed_at DESC);
`;

/**
 * V3 moves follow-up chat out of one ever-growing JSON cell. Messages can now
 * be appended transactionally and read in bounded pages, so an active Plus
 * user cannot make a session detail screen parse/render an unbounded blob.
 */
const SCHEMA_V3 = `
  CREATE TABLE session_chat_messages (
    owner_user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    PRIMARY KEY (owner_user_id, session_id, sequence),
    FOREIGN KEY (owner_user_id, session_id)
      REFERENCES sessions(owner_user_id, id) ON DELETE CASCADE
  );

  INSERT INTO session_chat_messages (
    owner_user_id, session_id, sequence, role, content, timestamp
  )
  WITH normalized AS (
    SELECT
      owner_user_id,
      id,
      created_at,
      CASE
        WHEN json_valid(chat_history)
        THEN CASE
          WHEN json_type(chat_history) = 'array' THEN chat_history
          ELSE '[]'
        END
        ELSE '[]'
      END AS history
    FROM sessions
  )
  SELECT
    n.owner_user_id,
    n.id,
    CAST(j.key AS INTEGER),
    json_extract(n.history, '$[' || j.key || '].role'),
    substr(json_extract(n.history, '$[' || j.key || '].content'), 1, 8000),
    CASE
      WHEN json_type(n.history, '$[' || j.key || '].timestamp') = 'text'
      THEN json_extract(n.history, '$[' || j.key || '].timestamp')
      ELSE n.created_at
    END
  FROM normalized n, json_each(n.history) j
  WHERE json_extract(n.history, '$[' || j.key || '].role')
          IN ('user', 'assistant')
    AND json_type(n.history, '$[' || j.key || '].content') = 'text'
    AND length(json_extract(n.history, '$[' || j.key || '].content')) > 0;

  UPDATE sessions SET chat_history = NULL;

  CREATE INDEX idx_session_chat_owner_session_sequence
    ON session_chat_messages(owner_user_id, session_id, sequence DESC);
`;

/** Persist privacy-critical local cleanup across crashes and disk errors. */
const SCHEMA_V4 = `
  CREATE TABLE local_deletion_tombstones (
    owner_user_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );
`;

/**
 * V5 makes deletion recovery two-phase. An intent is never enough to erase
 * local learning data: only a server-confirmed accepted/completed deletion
 * advances to the retryable local-wipe phase.
 */
const SCHEMA_V5 = `
  ALTER TABLE local_deletion_tombstones
    ADD COLUMN phase TEXT NOT NULL DEFAULT 'intent'
      CHECK (phase IN ('intent', 'server_committed'));
`;

/**
 * V6 persists a logical AI request before it leaves the device. A process
 * restart therefore reuses the same server idempotency key instead of buying
 * the same analysis or sentence audio twice.
 */
const SCHEMA_V6 = `
  CREATE TABLE ai_operation_intents (
    owner_user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    capability TEXT NOT NULL CHECK (
      capability IN ('session_analysis', 'follow_up', 'speech_synthesis')
    ),
    logical_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending'
      CHECK (state IN ('pending', 'completed')),
    local_result_uri TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY (owner_user_id, capability, logical_key),
    UNIQUE (owner_user_id, idempotency_key)
  );

  CREATE INDEX idx_ai_operation_intents_owner_state
    ON ai_operation_intents(owner_user_id, state, updated_at);

  CREATE INDEX idx_ai_operation_intents_owner_session_state
    ON ai_operation_intents(owner_user_id, session_id, state);
`;

/**
 * V7 bounds the compatibility JSON copy of card reviews. The normalized
 * card_review_events table remains the append-only source for new reviews;
 * cards need only a recent window for legacy display/interop.
 */
const SCHEMA_V7 = `
  UPDATE cards
  SET review_history = '[]'
  WHERE CASE
    WHEN json_valid(review_history)
    THEN json_type(review_history) <> 'array'
    ELSE 1
  END;

  UPDATE cards
  SET review_history = (
    SELECT COALESCE(json_group_array(json(value)), '[]')
    FROM (
      SELECT value, key
      FROM (
        SELECT value, key
        FROM json_each(cards.review_history)
        ORDER BY CAST(key AS INTEGER) DESC
        LIMIT 100
      )
      ORDER BY CAST(key AS INTEGER) ASC
    )
  )
  WHERE json_array_length(review_history) > 100;
`;

const MIGRATIONS: Readonly<Record<number, string>> = {
  1: SCHEMA_V1,
  2: SCHEMA_V2,
  3: SCHEMA_V3,
  4: SCHEMA_V4,
  5: SCHEMA_V5,
  6: SCHEMA_V6,
  7: SCHEMA_V7,
};

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDB(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync(DB_NAME);
      await migrate(db);
      await db.execAsync(`
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA wal_autocheckpoint = 256;
        PRAGMA journal_size_limit = 8388608;
      `);
      return db;
    })();
  }
  return dbPromise;
}

async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>(
    'PRAGMA user_version'
  );
  let current = row?.user_version ?? 0;

  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Database schema ${current} is newer than this app supports (${SCHEMA_VERSION})`
    );
  }

  while (current < SCHEMA_VERSION) {
    const next = current + 1;
    const sql = MIGRATIONS[next];
    if (!sql) throw new Error(`Missing database migration ${next}`);

    // The migration and its version marker commit together. A crash leaves
    // either the old schema or the complete new schema, never a mixture.
    await db.withExclusiveTransactionAsync(async (txn) => {
      await txn.execAsync(sql);
      const foreignKeyViolations = await txn.getAllAsync<{
        table: string;
        rowid: number;
        parent: string;
        fkid: number;
      }>('PRAGMA foreign_key_check');
      if (foreignKeyViolations.length > 0) {
        throw new Error(
          `Database migration ${next} produced ${foreignKeyViolations.length} foreign-key violation(s)`
        );
      }
      await txn.execAsync(`PRAGMA user_version = ${next}`);
    });
    current = next;
  }
}

/** Parse legacy/provider JSON without allowing one malformed row to crash UI. */
export function parseJsonArray<T>(s: string | null): T[] {
  if (!s) return [];
  try {
    const parsed: unknown = JSON.parse(s);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
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
