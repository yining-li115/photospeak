import {
  createEmptyCard,
  fsrs,
  Rating,
  State,
  type Card as FsrsCard,
} from 'ts-fsrs';
import type { Card, ReviewRecord } from '../types';

const scheduler = fsrs();
// Detailed future history lives in card_review_events. Keep a bounded recent
// compatibility window on the card row so one long-lived card never rewrites
// an ever-growing JSON blob on every review.
export const MAX_CARD_REVIEW_HISTORY = 100;

export type CardRating = 1 | 2 | 3 | 4;

type FsrsGrade = Exclude<Rating, Rating.Manual>;

const RATING_TO_FSRS: Record<CardRating, FsrsGrade> = {
  1: Rating.Again,
  2: Rating.Hard,
  3: Rating.Good,
  4: Rating.Easy,
};

export interface ScheduledUpdate {
  next_review_at: string;
  stability: number;
  difficulty: number;
  fsrs_elapsed_days: number;
  fsrs_scheduled_days: number;
  fsrs_learning_steps: number;
  fsrs_reps: number;
  fsrs_lapses: number;
  fsrs_state: 0 | 1 | 2 | 3;
  fsrs_last_review_at: string;
  review_history: ReviewRecord[];
}

export function scheduleCard(
  card: Card,
  rating: CardRating,
  now: Date = new Date()
): ScheduledUpdate {
  const fsrsCard = toFsrsCard(card, now);
  const result = scheduler.next(fsrsCard, now, RATING_TO_FSRS[rating]);

  const newRecord: ReviewRecord = {
    date: now.toISOString(),
    rating,
  };

  return {
    next_review_at: result.card.due.toISOString(),
    stability: result.card.stability,
    difficulty: result.card.difficulty,
    fsrs_elapsed_days: result.card.elapsed_days,
    fsrs_scheduled_days: result.card.scheduled_days,
    fsrs_learning_steps: result.card.learning_steps,
    fsrs_reps: result.card.reps,
    fsrs_lapses: result.card.lapses,
    fsrs_state: normalizeState(result.card.state),
    fsrs_last_review_at: result.card.last_review?.toISOString() ?? newRecord.date,
    review_history: [
      ...card.review_history.slice(-(MAX_CARD_REVIEW_HISTORY - 1)),
      newRecord,
    ],
  };
}

function toFsrsCard(card: Card, now: Date): FsrsCard {
  // Truly new cards should use the library initializer so changes in ts-fsrs
  // defaults remain centralized there.
  if (card.fsrs_reps === 0 && card.fsrs_state === State.New) {
    return createEmptyCard<FsrsCard>(now);
  }

  const lastReview = parseOptionalDate(card.fsrs_last_review_at);

  return {
    due: parseDateOr(card.next_review_at, now),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.fsrs_elapsed_days,
    scheduled_days: card.fsrs_scheduled_days,
    learning_steps: card.fsrs_learning_steps,
    reps: card.fsrs_reps,
    lapses: card.fsrs_lapses,
    state: card.fsrs_state as State,
    last_review: lastReview,
  };
}

function parseOptionalDate(value: string | null): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseDateOr(value: string, fallback: Date): Date {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function normalizeState(state: State): 0 | 1 | 2 | 3 {
  if (state === State.Learning) return 1;
  if (state === State.Review) return 2;
  if (state === State.Relearning) return 3;
  return 0;
}
