import {
  createEmptyCard,
  fsrs,
  Rating,
  State,
  type Card as FsrsCard,
} from 'ts-fsrs';
import type { Card, ReviewRecord } from '../types';

const scheduler = fsrs();

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
    review_history: [...card.review_history, newRecord],
  };
}

function toFsrsCard(card: Card, now: Date): FsrsCard {
  const lastReviewIso = card.review_history[card.review_history.length - 1]?.date;
  const lastReview = lastReviewIso ? new Date(lastReviewIso) : null;

  // First review ever — let ts-fsrs initialize a fresh card.
  if (!lastReview && card.stability === 0) {
    return createEmptyCard<FsrsCard>(now);
  }

  const elapsedDays = lastReview
    ? Math.max(
        0,
        Math.floor(
          (now.getTime() - lastReview.getTime()) / (1000 * 60 * 60 * 24)
        )
      )
    : 0;

  return {
    due: new Date(card.next_review_at),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: elapsedDays,
    scheduled_days: 0,
    learning_steps: 0,
    reps: card.review_history.length,
    lapses: card.review_history.filter((r) => r.rating === 1).length,
    state: card.stability > 0 ? State.Review : State.New,
    last_review: lastReview ?? undefined,
  };
}
