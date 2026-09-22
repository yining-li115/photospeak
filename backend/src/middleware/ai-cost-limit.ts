import { and, eq, gte, sql } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { db, schema } from '../db/client.js';
import type { AuthVars } from '../auth/middleware.js';

export interface AiCostLimitOptions {
  limitMicros: (plan: string) => number | undefined;
}

export interface AiCostLimitDecision {
  exceeded: boolean;
  totalMicros: number;
  limitMicros?: number;
}

function utcDayStart(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
}

/** Provider-neutral daily cost circuit breaker backed by the usage ledger. */
export function aiCostLimit(
  options: AiCostLimitOptions
): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    const plan = c.get('plan');
    const limit = options.limitMicros(plan);
    const decision = await checkAiCostLimit({
      userId: c.get('userId'),
      plan,
      limitMicros: limit,
    });
    if (!decision.limitMicros) {
      await next();
      return;
    }
    if (decision.exceeded) {
      return c.json(
        {
          error: '今日用量异常，请稍后再试',
          code: 'COST_SAFETY_LIMIT',
        },
        429
      );
    }
    if (decision.totalMicros >= decision.limitMicros * 0.8) {
      console.warn(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: 'ai.cost.soft_threshold',
          userId: c.get('userId'),
          plan,
          totalMicros: decision.totalMicros,
          limitMicros: decision.limitMicros,
        })
      );
    }
    await next();
  };
}

/** Call only after a durable idempotency claim, so cached replays bypass cost. */
export async function checkAiCostLimit(input: {
  userId: string;
  plan: string;
  limitMicros?: number;
}): Promise<AiCostLimitDecision> {
  if (!input.limitMicros || input.limitMicros <= 0) {
    return { exceeded: false, totalMicros: 0 };
  }
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${schema.aiUsageEvents.estimatedCostMicros}), 0)`,
    })
    .from(schema.aiUsageEvents)
    .where(
      and(
        eq(schema.aiUsageEvents.userId, input.userId),
        eq(schema.aiUsageEvents.status, 'succeeded'),
        gte(schema.aiUsageEvents.createdAt, utcDayStart())
      )
    );
  const totalMicros = Number(row?.total ?? 0);
  return {
    exceeded: totalMicros >= input.limitMicros,
    totalMicros,
    limitMicros: input.limitMicros,
  };
}
