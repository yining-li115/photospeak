import type { AnalyzeRequest, TtsRequest } from './contracts.js';
import {
  AiGateway,
  AiOutputValidationError,
  ContentRejectedError,
  type CompatibleChatResponse,
} from './gateway.js';
import {
  AiExecutionDeferred,
  AiExecutionOutcomeUnknown,
  AiOperationService,
  type AiOperationResult,
  type StoredAiResponse,
} from './idempotency.js';
import { AiProviderError } from './types.js';
import { checkAiCostLimit } from '../middleware/ai-cost-limit.js';
import { safeLogReference } from '../logging/safe-reference.js';

export interface AiOrchestratorConfig {
  gateway: AiGateway;
  operations: AiOperationService;
  freeDailyCostLimitMicros?: number;
  plusDailyCostLimitMicros?: number;
}

export interface AiRequestContext {
  requestId: string;
  idempotencyKey: string;
  userId: string;
  plan: string;
}

/** Application service: routes only translate HTTP into this domain boundary. */
export class AiOrchestrator {
  constructor(private readonly config: AiOrchestratorConfig) {}

  analyze(
    request: AnalyzeRequest,
    context: AiRequestContext
  ): Promise<AiOperationResult<CompatibleChatResponse>> {
    const policy = this.config.gateway.operationPolicy(request.operation);
    return this.config.operations.execute({
      userId: context.userId,
      capability: request.operation,
      idempotencyKey: context.idempotencyKey,
      request,
      executionFingerprint: policy.executionFingerprint,
      provider: policy.provider,
      model: policy.model,
      providerCapability: policy.idempotencyCapability,
      prepare: () => this.assertCostAvailable(context),
      execute: ({ operationId, providerIdempotencyKey }) =>
        this.invokeProvider(context, operationId, async () =>
          this.config.gateway.analyze(request, {
            requestId: context.requestId,
            operationId,
            providerIdempotencyKey,
            userId: context.userId,
            plan: context.plan,
          })
        ),
    });
  }

  synthesize(
    request: TtsRequest,
    context: AiRequestContext
  ): Promise<AiOperationResult<CompatibleChatResponse>> {
    const policy = this.config.gateway.operationPolicy('speech_synthesis');
    return this.config.operations.execute({
      userId: context.userId,
      capability: 'speech_synthesis',
      idempotencyKey: context.idempotencyKey,
      request,
      executionFingerprint: policy.executionFingerprint,
      provider: policy.provider,
      model: policy.model,
      providerCapability: policy.idempotencyCapability,
      prepare: () => this.assertCostAvailable(context),
      execute: ({ operationId, providerIdempotencyKey }) =>
        this.invokeProvider(context, operationId, async () =>
          this.config.gateway.synthesize(request, {
            requestId: context.requestId,
            operationId,
            providerIdempotencyKey,
            userId: context.userId,
            plan: context.plan,
          })
        ),
    });
  }

  private async assertCostAvailable(context: AiRequestContext): Promise<void> {
    let cost: Awaited<ReturnType<typeof checkAiCostLimit>>;
    try {
      cost = await checkAiCostLimit({
        userId: context.userId,
        plan: context.plan,
        limitMicros:
          context.plan === 'plus'
            ? this.config.plusDailyCostLimitMicros
            : this.config.freeDailyCostLimitMicros,
      });
    } catch {
      // The provider is definitely untouched, so this operation stays safely
      // retryable with the same key instead of becoming UNCERTAIN.
      throw new AiExecutionDeferred(
        'AI_COST_CHECK_UNAVAILABLE',
        503,
        5
      );
    }
    if (cost.exceeded) {
      throw new AiExecutionDeferred('COST_SAFETY_LIMIT', 429, 3600);
    }
  }

  private async invokeProvider(
    context: AiRequestContext,
    operationId: string,
    callProvider: () => Promise<CompatibleChatResponse>
  ): Promise<StoredAiResponse> {
    try {
      return { status: 200, body: await callProvider() };
    } catch (error) {
      if (error instanceof ContentRejectedError) {
        return {
          status: 422,
          errorCode: 'CONTENT_REJECTED',
          body: {
            error: '该内容暂时无法处理',
            code: 'CONTENT_REJECTED',
            request_id: context.requestId,
            operation_id: operationId,
          },
        };
      }
      if (
        error instanceof AiProviderError &&
        (error.kind === 'timeout' || error.kind === 'unavailable')
      ) {
        throw new AiExecutionOutcomeUnknown(`provider_${error.kind}`);
      }
      if (
        error instanceof AiProviderError &&
        (error.kind === 'rate_limited' ||
          error.kind === 'authentication' ||
          error.kind === 'billing' ||
          error.kind === 'configuration')
      ) {
        throw new AiExecutionDeferred(
          error.kind === 'rate_limited'
            ? 'AI_BUSY'
            : error.kind === 'billing'
              ? 'AI_PROVIDER_BILLING_ERROR'
              : 'AI_PROVIDER_CONFIGURATION_ERROR',
          503,
          error.kind === 'rate_limited' ? 5 : 60
        );
      }
      if (
        error instanceof AiProviderError ||
        error instanceof AiOutputValidationError
      ) {
        return providerErrorPayload(error, context.requestId, operationId);
      }
      throw error;
    }
  }
}

function providerErrorPayload(
  error: AiProviderError | AiOutputValidationError,
  requestId: string,
  operationId: string
): StoredAiResponse {
  const code =
    error instanceof AiOutputValidationError
      ? 'AI_INVALID_RESPONSE'
      : error.kind === 'bad_response'
        ? 'AI_INVALID_RESPONSE'
        : 'AI_UNAVAILABLE';
  const status = code === 'AI_INVALID_RESPONSE' ? 502 : 503;
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'ai.request.failed',
      requestRef: safeLogReference('ai-request', requestId),
      operationRef: safeLogReference('ai-operation', operationId),
      code,
      upstreamStatus:
        error instanceof AiProviderError ? error.upstreamStatus : undefined,
      upstreamCode:
        error instanceof AiProviderError ? error.upstreamCode : undefined,
    })
  );
  return {
    status,
    errorCode: code,
    body: {
      error: 'AI 服务暂时不可用，请稍后重试',
      code,
      request_id: requestId,
      operation_id: operationId,
    },
  };
}
