import { db, schema } from '../db/client.js';

export type AiCapability =
  | 'session_analysis'
  | 'follow_up'
  | 'speech_synthesis'
  | 'transcribe';

export interface UsageEventInput {
  requestId: string;
  operationId: string;
  userId: string;
  capability: AiCapability;
  provider: string;
  model: string;
  status: 'succeeded' | 'failed';
  plan?: string;
  inputUnits?: number;
  outputUnits?: number;
  estimatedCostMicros?: number;
  billingCurrency?: string;
  latencyMs: number;
  errorCode?: string;
}

/** Usage accounting must never make an otherwise successful AI call fail. */
export async function recordUsage(input: UsageEventInput): Promise<void> {
  try {
    await db
      .insert(schema.aiUsageEvents)
      .values({
        requestId: input.requestId,
        operationId: input.operationId,
        userId: input.userId,
        capability: input.capability,
        provider: input.provider,
        model: input.model,
        status: input.status,
        plan: input.plan ?? 'free',
        inputUnits: input.inputUnits,
        outputUnits: input.outputUnits,
        estimatedCostMicros: input.estimatedCostMicros,
        billingCurrency: input.billingCurrency,
        latencyMs: input.latencyMs,
        errorCode: input.errorCode,
      })
      .onConflictDoUpdate({
        target: [
          schema.aiUsageEvents.userId,
          schema.aiUsageEvents.operationId,
        ],
        set: {
          requestId: input.requestId,
          status: input.status,
          plan: input.plan ?? 'free',
          inputUnits: input.inputUnits,
          outputUnits: input.outputUnits,
          estimatedCostMicros: input.estimatedCostMicros,
          billingCurrency: input.billingCurrency,
          latencyMs: input.latencyMs,
          errorCode: input.errorCode,
        },
      });
  } catch (error) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'ai.usage.write_failed',
        requestId: input.requestId,
        userId: input.userId,
        message: error instanceof Error ? error.message : String(error),
      })
    );
  }
}
