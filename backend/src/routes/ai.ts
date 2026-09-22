import { randomUUID } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  analyzeRequestSchema,
  ttsRequestSchema,
} from '../ai/contracts.js';
import { AiIdempotencyError } from '../ai/idempotency.js';
import { AiOrchestrator } from '../ai/orchestrator.js';
import { requireUser, type AuthVars } from '../auth/middleware.js';
import { concurrencyLimit } from '../middleware/concurrency-limit.js';
import { rateLimit } from '../middleware/rate-limit.js';
import {
  completeFreeOperation,
  FreeQuotaError,
  releaseFreeOperation,
  reserveFreeOperation,
} from '../subscriptions/free-quota.js';

export interface AiRouterConfig {
  orchestrator: AiOrchestrator;
  globalConcurrency?: number;
  requestsPerMinute?: number;
  freeDailySafetyLimit?: number;
  plusDailySafetyLimit?: number;
}

function validationHook(
  result: { success: boolean; error?: { issues?: unknown[] } },
  c: Context
) {
  if (result.success) return;
  return c.json(
    {
      error: '请求参数无效',
      code: 'VALIDATION_ERROR',
    },
    400
  );
}

function requestId(): string {
  // Transport correlation stays distinct from the durable logical operation.
  return randomUUID();
}

function idempotencyErrorResponse(c: Context, error: AiIdempotencyError) {
  if (error.retryAfterSeconds) {
    c.header('Retry-After', String(error.retryAfterSeconds));
  }
  if (error.operationId) c.header('X-Operation-ID', error.operationId);
  const messages: Record<string, string> = {
    IDEMPOTENCY_KEY_INVALID: '请求标识无效，请更新 App 后重试',
    IDEMPOTENCY_KEY_EXPIRED: '旧请求标识已过安全期限，请确认后重新生成',
    IDEMPOTENCY_RECOVERY_FENCE:
      '数据恢复后无法确认此旧请求是否已执行，请确认后重新生成',
    IDEMPOTENCY_KEY_CONFLICT: '请求标识已用于不同内容',
    IDEMPOTENCY_RESULT_EXPIRED: '上次结果已过安全缓存期，请确认后重新生成',
    AI_OPERATION_POLICY_CHANGED: 'AI 模型配置已更新，请确认后重新生成',
    AI_OPERATION_IN_PROGRESS: 'AI 正在处理中，请稍后继续等待',
    AI_OPERATION_RETRYABLE: 'AI 服务暂时不可用，请稍后重试',
    AI_BUSY: 'AI 服务繁忙，请稍后重试',
    AI_PROVIDER_CONFIGURATION_ERROR: 'AI 服务配置暂时不可用',
    AI_COST_CHECK_UNAVAILABLE: 'AI 用量校验暂时不可用，请稍后重试',
    AI_EXECUTION_PREPARATION_FAILED: 'AI 请求准备失败，请稍后重试',
    COST_SAFETY_LIMIT: '今日用量异常，请稍后再试',
    AI_OPERATION_UNCERTAIN:
      '上次 AI 请求结果仍在核对，为避免重复计费不会自动重试',
    AI_OPERATION_UNAVAILABLE: 'AI 操作暂时不可用，请稍后重试',
  };
  return c.json(
    {
      error: messages[error.code] ?? 'AI 服务暂时不可用',
      code: error.code,
      operation_id: error.operationId,
    },
    error.status as never
  );
}

export function createAiRouter(config: AiRouterConfig) {
  const router = new Hono<{ Variables: AuthVars }>();
  router.use('*', requireUser());

  router.use(
    '*',
    rateLimit({
      name: 'ai-minute',
      windowMs: 60_000,
      max: config.requestsPerMinute ?? 60,
      keyFn: (c) => `user:${c.get('userId')}`,
      code: 'AI_RATE_LIMITED',
    }),
    rateLimit({
      // A high anti-abuse ceiling, not a customer-facing session allowance.
      // It protects a leaked JWT/key while allowing normal "unlimited" use.
      name: 'ai-daily-safety',
      windowMs: 24 * 60 * 60 * 1000,
      max: (c) =>
        c.get('plan') === 'plus'
          ? config.plusDailySafetyLimit ?? 1_000
          : config.freeDailySafetyLimit ?? 200,
      softLimit: (c) =>
        Math.floor(
          (c.get('plan') === 'plus'
            ? config.plusDailySafetyLimit ?? 1_000
            : config.freeDailySafetyLimit ?? 200) * 0.8
        ),
      keyFn: (c) => `plan:${c.get('plan')}:user:${c.get('userId')}`,
      message: '今日请求异常频繁，请稍后再试',
      code: 'USAGE_SAFETY_LIMIT',
    })
  );

  // TTS generation and analysis are both expensive and return large payloads.
  // One in-flight call per capability/user prevents button mashing and simple
  // automation from multiplying cost. Replace the in-memory lease with Redis
  // before running more than one API process.
  router.use(
    '*',
    concurrencyLimit({
      max: config.globalConcurrency ?? 4,
      keyFn: () => 'global-ai',
    }),
    concurrencyLimit({
      max: 1,
      keyFn: (c) => `user:${c.get('userId')}:${c.req.path}`,
    })
  );

  router.post(
    '/analyze',
    bodyLimit({
      maxSize: 4 * 1024 * 1024,
      onError: (c) =>
        c.json({ error: '请求内容过大', code: 'BODY_TOO_LARGE' }, 413),
    }),
    zValidator('json', analyzeRequestSchema, validationHook),
    async (c) => {
      const id = requestId();
      c.header('X-Request-ID', id);
      const request = c.req.valid('json');
      const idempotencyKey = c.req.header('Idempotency-Key') ?? '';
      let quotaReservation = null;
      try {
        quotaReservation = await reserveFreeOperation({
          userId: c.get('userId'),
          plan: c.get('plan'),
          clientSessionId: request.client_session_id,
          capability: request.operation,
          idempotencyKey,
        });
        const result = await config.orchestrator.analyze(request, {
          requestId: id,
          idempotencyKey,
          userId: c.get('userId'),
          plan: c.get('plan'),
        });
        await completeFreeOperation(quotaReservation);
        c.header('X-Operation-ID', result.operationId);
        c.header('Idempotency-Replayed', result.replayed ? 'true' : 'false');
        return c.json(result.body, result.status as never);
      } catch (error) {
        if (error instanceof FreeQuotaError) {
          return c.json(
            { error: error.message, code: error.code },
            402
          );
        }
        if (
          !(
            error instanceof AiIdempotencyError &&
            (error.code === 'AI_OPERATION_IN_PROGRESS' ||
              error.code === 'AI_OPERATION_UNCERTAIN')
          )
        ) {
          await releaseFreeOperation(quotaReservation).catch(() => {});
        }
        if (error instanceof AiIdempotencyError) {
          return idempotencyErrorResponse(c, error);
        }
        throw error;
      }
    }
  );

  router.post(
    '/tts',
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (c) =>
        c.json({ error: '请求内容过大', code: 'BODY_TOO_LARGE' }, 413),
    }),
    zValidator('json', ttsRequestSchema, validationHook),
    async (c) => {
      const id = requestId();
      c.header('X-Request-ID', id);
      const request = c.req.valid('json');
      try {
        const result = await config.orchestrator.synthesize(request, {
          requestId: id,
          idempotencyKey: c.req.header('Idempotency-Key') ?? '',
          userId: c.get('userId'),
          plan: c.get('plan'),
        });
        c.header('X-Operation-ID', result.operationId);
        c.header('Idempotency-Replayed', result.replayed ? 'true' : 'false');
        return c.json(result.body, result.status as never);
      } catch (error) {
        if (error instanceof AiIdempotencyError) {
          return idempotencyErrorResponse(c, error);
        }
        throw error;
      }
    }
  );

  return router;
}
