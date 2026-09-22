import { createHash } from 'node:crypto';
import { and, count, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';

export const FREE_MONTHLY_SESSION_LIMIT = 5;
export const FREE_FOLLOW_UP_LIMIT = 1;

export class FreeQuotaError extends Error {
  constructor(
    public readonly code:
      | 'QUOTA_SESSION_LIMIT'
      | 'QUOTA_FOLLOW_UP_LIMIT',
    message: string
  ) {
    super(message);
    this.name = 'FreeQuotaError';
  }
}

export interface QuotaReservation {
  id: string;
  reusedCompleted: boolean;
}

/** Reserve a free-plan operation before any paid provider dispatch. */
export async function reserveFreeOperation(input: {
  userId: string;
  plan: string;
  clientSessionId: string;
  capability: 'session_analysis' | 'follow_up';
  idempotencyKey: string;
}): Promise<QuotaReservation | null> {
  if (input.plan === 'plus') return null;
  const periodMonth = utcMonthKey(new Date());
  const operationKeyHash = sha256(input.idempotencyKey);

  return db.transaction(async (tx) => {
    // Serialize quota decisions for one user/month across every API process.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`subscription:${input.userId}:${periodMonth}`}, 0))`
    );
    const [existing] = await tx
      .select({
        id: schema.subscriptionUsageReservations.id,
        state: schema.subscriptionUsageReservations.state,
        operationKeyHash:
          schema.subscriptionUsageReservations.operationKeyHash,
      })
      .from(schema.subscriptionUsageReservations)
      .where(
        and(
          eq(schema.subscriptionUsageReservations.userId, input.userId),
          eq(
            schema.subscriptionUsageReservations.clientSessionId,
            input.clientSessionId
          ),
          eq(
            schema.subscriptionUsageReservations.capability,
            input.capability
          )
        )
      )
      .limit(1);

    if (existing) {
      if (existing.operationKeyHash !== operationKeyHash) {
        if (input.capability === 'follow_up') {
          throw new FreeQuotaError(
            'QUOTA_FOLLOW_UP_LIMIT',
            '免费版每个 Session 可追问 1 次，升级 Plus 后可不限次追问'
          );
        }
        throw new FreeQuotaError(
          'QUOTA_SESSION_LIMIT',
          '当前 Session 已完成分析，请新建 Session 后继续练习'
        );
      }
      return {
        id: existing.id,
        reusedCompleted: existing.state === 'completed',
      };
    }

    if (input.capability === 'session_analysis') {
      const [usage] = await tx
        .select({ value: count() })
        .from(schema.subscriptionUsageReservations)
        .where(
          and(
            eq(schema.subscriptionUsageReservations.userId, input.userId),
            eq(
              schema.subscriptionUsageReservations.periodMonth,
              periodMonth
            ),
            eq(
              schema.subscriptionUsageReservations.capability,
              'session_analysis'
            )
          )
        );
      if ((usage?.value ?? 0) >= FREE_MONTHLY_SESSION_LIMIT) {
        throw new FreeQuotaError(
          'QUOTA_SESSION_LIMIT',
          `免费版每月可完成 ${FREE_MONTHLY_SESSION_LIMIT} 个 Session，升级 Plus 后可不限次练习`
        );
      }
    } else {
      const [completedAnalysis] = await tx
        .select({ id: schema.subscriptionUsageReservations.id })
        .from(schema.subscriptionUsageReservations)
        .where(
          and(
            eq(schema.subscriptionUsageReservations.userId, input.userId),
            eq(
              schema.subscriptionUsageReservations.clientSessionId,
              input.clientSessionId
            ),
            eq(
              schema.subscriptionUsageReservations.capability,
              'session_analysis'
            ),
            eq(schema.subscriptionUsageReservations.state, 'completed')
          )
        )
        .limit(1);
      if (!completedAnalysis) {
        throw new FreeQuotaError(
          'QUOTA_FOLLOW_UP_LIMIT',
          '请先完成当前 Session 的分析；免费版每个 Session 可追问 1 次'
        );
      }
    }

    const [created] = await tx
      .insert(schema.subscriptionUsageReservations)
      .values({
        userId: input.userId,
        periodMonth,
        clientSessionId: input.clientSessionId,
        capability: input.capability,
        operationKeyHash,
      })
      .returning({ id: schema.subscriptionUsageReservations.id });
    return { id: created.id, reusedCompleted: false };
  });
}

export async function completeFreeOperation(
  reservation: QuotaReservation | null
): Promise<void> {
  if (!reservation || reservation.reusedCompleted) return;
  await db
    .update(schema.subscriptionUsageReservations)
    .set({ state: 'completed', completedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.subscriptionUsageReservations.id, reservation.id));
}

export async function releaseFreeOperation(
  reservation: QuotaReservation | null
): Promise<void> {
  if (!reservation || reservation.reusedCompleted) return;
  await db
    .delete(schema.subscriptionUsageReservations)
    .where(
      and(
        eq(schema.subscriptionUsageReservations.id, reservation.id),
        eq(schema.subscriptionUsageReservations.state, 'reserved')
      )
    );
}

export async function readFreeUsage(userId: string): Promise<{
  periodMonth: string;
  completedSessions: number;
  sessionLimit: number;
}> {
  const periodMonth = utcMonthKey(new Date());
  const [usage] = await db
    .select({ value: count() })
    .from(schema.subscriptionUsageReservations)
    .where(
      and(
        eq(schema.subscriptionUsageReservations.userId, userId),
        eq(schema.subscriptionUsageReservations.periodMonth, periodMonth),
        eq(
          schema.subscriptionUsageReservations.capability,
          'session_analysis'
        ),
        eq(schema.subscriptionUsageReservations.state, 'completed')
      )
    );
  return {
    periodMonth,
    completedSessions: usage?.value ?? 0,
    sessionLimit: FREE_MONTHLY_SESSION_LIMIT,
  };
}

function utcMonthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(
    2,
    '0'
  )}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
