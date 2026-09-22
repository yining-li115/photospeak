import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const schemaSource = readFileSync(
  new URL('../src/db/schema.ts', import.meta.url),
  'utf8'
);

function migration(name) {
  const pattern = 'const ' + name + ' = `([\\s\\S]*?)`;';
  const match = new RegExp(pattern).exec(schemaSource);
  assert.ok(match, `missing ${name}`);
  return match[1];
}

test('V1 beta data survives malformed JSON while upgrading through V7', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(migration('SCHEMA_V1'));

  const insertSession = db.prepare(`
    INSERT INTO sessions (
      id, created_at, photo_uri, photo_thumbnail_uri, recording_uri,
      transcript, corrected_sentences, polished_sentences,
      sentence_audio_uris, chunks, chat_history,
      podcast_generated, cards_generated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
  `);
  insertSession.run(
    'broken-json',
    '2026-01-01T00:00:00.000Z',
    'photos/broken.jpg',
    'thumbnails/broken.jpg',
    '',
    'hello',
    '[]',
    'not-json',
    '[]',
    'not-json',
    'not-json'
  );
  insertSession.run(
    'valid-json',
    '2026-01-02T00:00:00.000Z',
    'photos/valid.jpg',
    'thumbnails/valid.jpg',
    '',
    'hello',
    '[]',
    '["A sentence"]',
    '[]',
    '[{"id":"c","chunk":"hello","usage_note":"","examples":[]}]',
    '[{"role":"user","content":"Why?","timestamp":"2026-01-02T00:01:00.000Z"}]'
  );

  const insertCard = db.prepare(`
    INSERT INTO cards (
      id, chunk_id, chunk, usage_note, examples, photo_thumbnail_uri,
      source_session_id, created_at, next_review_at, stability, difficulty,
      review_history
    ) VALUES (?, 'chunk', 'hello', '', '[]', 'thumbnails/valid.jpg', ?,
              '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z', 1, 1, ?)
  `);
  insertCard.run('bad-review-json', 'broken-json', 'not-json');
  // A structurally valid array with no usable date used to produce NULL for a
  // NOT NULL FSRS column and abort the whole migration.
  insertCard.run('missing-review-date', 'valid-json', '[{}]');
  insertCard.run('orphan', 'missing-session', '[]');

  db.exec("INSERT INTO stats VALUES ('2026-01-02', 1, 2, 3)");
  db.exec(`BEGIN; ${migration('SCHEMA_V2')} COMMIT;`);
  db.exec(`BEGIN; ${migration('SCHEMA_V3')} COMMIT;`);
  db.exec(`BEGIN; ${migration('SCHEMA_V4')} COMMIT;`);
  db.exec(`BEGIN; ${migration('SCHEMA_V5')} COMMIT;`);
  db.exec(`BEGIN; ${migration('SCHEMA_V6')} COMMIT;`);
  const longHistory = Array.from({ length: 125 }, (_, index) => ({
    date: new Date(Date.UTC(2025, 0, 1, 0, index)).toISOString(),
    rating: (index % 4) + 1,
  }));
  db.prepare(
    "UPDATE cards SET review_history = ? WHERE id = 'missing-review-date'"
  ).run(JSON.stringify(longHistory));
  db.exec(`BEGIN; ${migration('SCHEMA_V7')} COMMIT;`);

  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,
    2
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cards').get().n, 2);
  assert.equal(
    db
      .prepare(
        "SELECT fsrs_scheduled_days FROM cards WHERE id = 'missing-review-date'"
      )
      .get().fsrs_scheduled_days,
    0
  );
  const chatMessages = db
    .prepare(
      'SELECT role, content FROM session_chat_messages ORDER BY sequence'
    )
    .all()
    .map(({ role, content }) => ({ role, content }));
  assert.deepEqual(
    chatMessages,
    [{ role: 'user', content: 'Why?' }]
  );
  const compactedHistory = JSON.parse(
    db.prepare(
      "SELECT review_history FROM cards WHERE id = 'missing-review-date'"
    ).get().review_history
  );
  assert.equal(compactedHistory.length, 100);
  assert.deepEqual(compactedHistory[0], longHistory[25]);
  assert.deepEqual(compactedHistory.at(-1), longHistory.at(-1));
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.exec(
    "INSERT INTO local_deletion_tombstones VALUES ('owner', '2026-01-02', 'intent')"
  );
  assert.equal(
    db
      .prepare(
        "SELECT phase FROM local_deletion_tombstones WHERE owner_user_id = 'owner'"
      )
      .get().phase,
    'intent'
  );
  db.exec(`
    INSERT INTO ai_operation_intents (
      owner_user_id, session_id, capability, logical_key, request_hash,
      idempotency_key, state, created_at, updated_at
    ) VALUES (
      'owner', 'session', 'speech_synthesis', 'tts:session:0:hash',
      '${'a'.repeat(64)}', '11111111-1111-4111-8111-111111111111',
      'pending', '2026-01-02', '2026-01-02'
    )
  `);
  assert.equal(
    db.prepare(
      `SELECT idempotency_key FROM ai_operation_intents
       WHERE owner_user_id = 'owner'`
    ).get().idempotency_key,
    '11111111-1111-4111-8111-111111111111'
  );
  // A restarted TTS pipeline attempts the same logical insert with a freshly
  // generated candidate key. INSERT OR IGNORE must preserve the original key
  // that the server already associated with the billable operation.
  db.exec(`
    INSERT OR IGNORE INTO ai_operation_intents (
      owner_user_id, session_id, capability, logical_key, request_hash,
      idempotency_key, state, created_at, updated_at
    ) VALUES (
      'owner', 'session', 'speech_synthesis', 'tts:session:0:hash',
      '${'a'.repeat(64)}', '22222222-2222-4222-8222-222222222222',
      'pending', '2026-01-03', '2026-01-03'
    );
    UPDATE ai_operation_intents
    SET state = 'completed', local_result_uri = 'users/owner/audio/sentence-0.mp3'
    WHERE owner_user_id = 'owner' AND logical_key = 'tts:session:0:hash';
  `);
  const resumedTts = db.prepare(
    `SELECT idempotency_key, state, local_result_uri
     FROM ai_operation_intents WHERE owner_user_id = 'owner'`
  ).get();
  assert.deepEqual({ ...resumedTts }, {
    idempotency_key: '11111111-1111-4111-8111-111111111111',
    state: 'completed',
    local_result_uri: 'users/owner/audio/sentence-0.mp3',
  });

  const committedOwner = db.prepare(
    "SELECT owner_user_id FROM sessions WHERE id = 'valid-json'"
  ).get().owner_user_id;
  db.prepare(`
    INSERT INTO ai_operation_intents (
      owner_user_id, session_id, capability, logical_key, request_hash,
      idempotency_key, state, local_result_uri, created_at, updated_at,
      completed_at
    ) VALUES (?, 'valid-json', 'speech_synthesis', 'tts:valid-json:0:hash', ?,
              '33333333-3333-4333-8333-333333333333', 'completed',
              'users/legacy/audio/committed.mp3', '2026-01-02', '2026-01-02',
              '2026-01-02')
  `).run(committedOwner, 'b'.repeat(64));
  db.exec(`
    INSERT INTO ai_operation_intents (
      owner_user_id, session_id, capability, logical_key, request_hash,
      idempotency_key, state, created_at, updated_at
    ) VALUES (
      'owner', 'pending-draft', 'speech_synthesis', 'tts:pending:0:hash',
      '${'c'.repeat(64)}', '44444444-4444-4444-8444-444444444444',
      'pending', '2026-01-02', '2026-01-02'
    )
  `);

  const staleAbandoned = db.prepare(`
    SELECT intent.logical_key, intent.local_result_uri
    FROM ai_operation_intents AS intent
    WHERE intent.capability = 'speech_synthesis'
      AND intent.state = 'completed'
      AND intent.local_result_uri IS NOT NULL
      AND intent.updated_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM sessions AS session
        WHERE session.owner_user_id = intent.owner_user_id
          AND session.id = intent.session_id
      )
  `).all('2026-02-01');
  assert.deepEqual(staleAbandoned.map(({ logical_key }) => logical_key), [
    'tts:session:0:hash',
  ]);

  // The file janitor deletes/observes the managed file first, then performs
  // this guarded metadata delete. A committed session or pending operation is
  // never selected even when it is old.
  db.prepare(`
    DELETE FROM ai_operation_intents
    WHERE owner_user_id = ? AND session_id = ?
      AND capability = 'speech_synthesis' AND logical_key = ?
      AND idempotency_key = ? AND state = 'completed'
      AND local_result_uri = ? AND updated_at = ? AND updated_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM sessions
        WHERE sessions.owner_user_id = ai_operation_intents.owner_user_id
          AND sessions.id = ai_operation_intents.session_id
      )
  `).run(
    'owner',
    'session',
    'tts:session:0:hash',
    '11111111-1111-4111-8111-111111111111',
    'users/owner/audio/sentence-0.mp3',
    '2026-01-02',
    '2026-02-01'
  );
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS n FROM ai_operation_intents WHERE logical_key = 'tts:session:0:hash'"
    ).get().n,
    0
  );
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS n FROM ai_operation_intents WHERE logical_key = 'tts:valid-json:0:hash'"
    ).get().n,
    1
  );
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS n FROM ai_operation_intents WHERE logical_key = 'tts:pending:0:hash'"
    ).get().n,
    1
  );
  db.close();
});
