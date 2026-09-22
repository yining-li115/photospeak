import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_CARD_REVIEW_HISTORY,
  scheduleCard,
} from '../src/srs/fsrs.ts';

test('card compatibility history stays bounded while retaining newest events', () => {
  const reviewHistory = Array.from(
    { length: MAX_CARD_REVIEW_HISTORY + 25 },
    (_, index) => ({
      date: new Date(Date.UTC(2025, 0, 1, 0, index)).toISOString(),
      rating: 3,
    })
  );
  const now = new Date('2026-09-19T12:00:00.000Z');
  const update = scheduleCard(
    {
      id: 'card',
      chunk_id: 'chunk',
      chunk: 'speak up',
      usage_note: '',
      examples: [],
      photo_thumbnail_uri: '',
      source_session_id: 'session',
      created_at: '2025-01-01T00:00:00.000Z',
      next_review_at: now.toISOString(),
      stability: 10,
      difficulty: 5,
      fsrs_elapsed_days: 1,
      fsrs_scheduled_days: 1,
      fsrs_learning_steps: 0,
      fsrs_reps: 1,
      fsrs_lapses: 0,
      fsrs_state: 2,
      fsrs_last_review_at: '2026-09-18T12:00:00.000Z',
      review_history: reviewHistory,
    },
    3,
    now
  );

  assert.equal(update.review_history.length, MAX_CARD_REVIEW_HISTORY);
  assert.deepEqual(
    update.review_history[0],
    reviewHistory[reviewHistory.length - (MAX_CARD_REVIEW_HISTORY - 1)]
  );
  assert.deepEqual(update.review_history.at(-1), {
    date: now.toISOString(),
    rating: 3,
  });
});
