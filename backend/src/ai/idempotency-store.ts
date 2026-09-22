import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { missingRequestHashKeyIds } from './idempotency-crypto.js';
import type {
  AiOperationRecord,
  AiOperationState,
  AiOperationStore,
} from './idempotency.js';
import type { AiCapability } from './usage.js';
import type { ProviderIdempotencyCapability } from './types.js';

export class PostgresAiOperationStore implements AiOperationStore {
  async getOrCreate(
    input: Parameters<AiOperationStore['getOrCreate']>[0]
  ): Promise<{ operation: AiOperationRecord; created: boolean }> {
    const inserted = await db
      .insert(schema.aiOperations)
      .values({
        id: input.id,
        userId: input.userId,
        capability: input.capability,
        idempotencyKeyHash: input.idempotencyKeyHash,
        idempotencyKeyVersion: input.idempotencyKeyVersion,
        dedupeExpiresAt: input.dedupeExpiresAt,
        requestHash: input.requestHash,
        requestHashKeyId: input.requestHashKeyId,
        contractVersion: input.contractVersion,
        executionFingerprint: input.executionFingerprint,
        provider: input.provider,
        model: input.model,
        providerCapability: input.providerCapability,
        providerIdempotencyKey: input.providerIdempotencyKey,
        state: input.initialState,
        errorCode:
          input.initialState === 'recovery_fenced'
            ? 'recovery_fence_unknown_key'
            : null,
      })
      .onConflictDoNothing({
        target: [
          schema.aiOperations.userId,
          schema.aiOperations.capability,
          schema.aiOperations.idempotencyKeyHash,
        ],
      })
      .returning();
    if (inserted[0]) {
      return { operation: mapOperation(inserted[0]), created: true };
    }
    const [existing] = await db
      .select()
      .from(schema.aiOperations)
      .where(
        and(
          eq(schema.aiOperations.userId, input.userId),
          eq(schema.aiOperations.capability, input.capability),
          eq(
            schema.aiOperations.idempotencyKeyHash,
            input.idempotencyKeyHash
          )
        )
      )
      .limit(1);
    if (!existing) {
      const [retriedRow] = await db
        .insert(schema.aiOperations)
        .values({
          id: input.id,
          userId: input.userId,
          capability: input.capability,
          idempotencyKeyHash: input.idempotencyKeyHash,
          idempotencyKeyVersion: input.idempotencyKeyVersion,
          dedupeExpiresAt: input.dedupeExpiresAt,
          requestHash: input.requestHash,
          requestHashKeyId: input.requestHashKeyId,
          contractVersion: input.contractVersion,
          executionFingerprint: input.executionFingerprint,
          provider: input.provider,
          model: input.model,
          providerCapability: input.providerCapability,
          providerIdempotencyKey: input.providerIdempotencyKey,
          state: input.initialState,
          errorCode:
            input.initialState === 'recovery_fenced'
              ? 'recovery_fence_unknown_key'
              : null,
        })
        .onConflictDoNothing()
        .returning();
      if (retriedRow) {
        return { operation: mapOperation(retriedRow), created: true };
      }
      throw new Error('AI operation conflict row changed during lookup');
    }
    return { operation: mapOperation(existing), created: false };
  }

  async get(id: string): Promise<AiOperationRecord | null> {
    const [row] = await db
      .select()
      .from(schema.aiOperations)
      .where(eq(schema.aiOperations.id, id))
      .limit(1);
    return row ? mapOperation(row) : null;
  }

  async claim(input: {
    id: string;
    expectedState: AiOperationState;
    workerId: string;
    now: Date;
    leaseUntil: Date;
  }): Promise<AiOperationRecord | null> {
    const [row] = await db
      .update(schema.aiOperations)
      .set({
        state: 'running',
        leaseOwner: input.workerId,
        leaseUntil: input.leaseUntil,
        attemptCount: sql`${schema.aiOperations.attemptCount} + 1`,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(schema.aiOperations.id, input.id),
          eq(schema.aiOperations.state, input.expectedState),
          input.expectedState === 'running'
            ? or(
                isNull(schema.aiOperations.leaseUntil),
                lte(schema.aiOperations.leaseUntil, input.now)
              )
            : undefined
        )
      )
      .returning();
    return row ? mapOperation(row) : null;
  }

  async markDispatched(input: {
    id: string;
    workerId: string;
    now: Date;
  }): Promise<boolean> {
    const rows = await db
      .update(schema.aiOperations)
      .set({ dispatchedAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(schema.aiOperations.id, input.id),
          eq(schema.aiOperations.state, 'running'),
          eq(schema.aiOperations.leaseOwner, input.workerId)
        )
      )
      .returning({ id: schema.aiOperations.id });
    return rows.length === 1;
  }

  async complete(input: {
    id: string;
    workerId: string;
    state: 'succeeded' | 'rejected' | 'failed_final';
    responseStatus: number;
    responseEnvelope: string;
    errorCode?: string;
    responseExpiresAt: Date;
    now: Date;
  }): Promise<boolean> {
    const rows = await db
      .update(schema.aiOperations)
      .set({
        state: input.state,
        responseStatus: input.responseStatus,
        responseEnvelope: input.responseEnvelope,
        errorCode: input.errorCode ?? null,
        responseExpiresAt: input.responseExpiresAt,
        completedAt: input.now,
        leaseOwner: null,
        leaseUntil: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(schema.aiOperations.id, input.id),
          eq(schema.aiOperations.state, 'running'),
          eq(schema.aiOperations.leaseOwner, input.workerId)
        )
      )
      .returning({ id: schema.aiOperations.id });
    return rows.length === 1;
  }

  async markRetryable(input: {
    id: string;
    workerId: string;
    errorCode: string;
    now: Date;
    clearDispatch?: boolean;
  }): Promise<void> {
    await db
      .update(schema.aiOperations)
      .set({
        state: 'retryable',
        errorCode: input.errorCode,
        leaseOwner: null,
        leaseUntil: null,
        dispatchedAt: input.clearDispatch ? null : undefined,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(schema.aiOperations.id, input.id),
          eq(schema.aiOperations.state, 'running'),
          eq(schema.aiOperations.leaseOwner, input.workerId)
        )
      );
  }

  async markUncertain(input: {
    id: string;
    workerId?: string;
    errorCode: string;
    now: Date;
    onlyIfLeaseExpired?: boolean;
  }): Promise<void> {
    await db
      .update(schema.aiOperations)
      .set({
        state: 'uncertain',
        errorCode: input.errorCode,
        leaseOwner: null,
        leaseUntil: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(schema.aiOperations.id, input.id),
          eq(schema.aiOperations.state, 'running'),
          input.workerId
            ? eq(schema.aiOperations.leaseOwner, input.workerId)
            : undefined,
          input.onlyIfLeaseExpired
            ? or(
                isNull(schema.aiOperations.leaseUntil),
                lte(schema.aiOperations.leaseUntil, input.now)
              )
            : undefined
        )
      );
  }

  async expireResults(now: Date): Promise<void> {
    await db
      .update(schema.aiOperations)
      .set({
        state: 'result_expired',
        responseEnvelope: null,
        updatedAt: now,
      })
      .where(
        and(
          inArray(schema.aiOperations.state, [
            'succeeded',
            'rejected',
            'failed_final',
          ]),
          lte(schema.aiOperations.responseExpiresAt, now)
        )
      );
  }

  /**
   * Validate the complete request-HMAC ring before accepting traffic. Missing
   * historical keys would otherwise make existing tombstones unverifiable.
   */
  async assertRequestHashKeysAvailable(
    configuredKeyIds: ReadonlySet<string>
  ): Promise<void> {
    const rows = await db
      .selectDistinct({ keyId: schema.aiOperations.requestHashKeyId })
      .from(schema.aiOperations);
    const missing = missingRequestHashKeyIds(
      rows.map(({ keyId }) => keyId),
      configuredKeyIds
    );
    if (missing.length > 0) {
      throw new Error(
        `AI request HMAC key ring is missing referenced key ids: ${missing.join(', ')}`
      );
    }
  }
}

function mapOperation(
  row: typeof schema.aiOperations.$inferSelect
): AiOperationRecord {
  return {
    id: row.id,
    userId: row.userId,
    capability: row.capability as AiCapability,
    idempotencyKeyHash: row.idempotencyKeyHash,
    idempotencyKeyVersion:
      row.idempotencyKeyVersion as AiOperationRecord['idempotencyKeyVersion'],
    dedupeExpiresAt: row.dedupeExpiresAt,
    requestHash: row.requestHash,
    requestHashKeyId: row.requestHashKeyId,
    contractVersion: row.contractVersion,
    executionFingerprint: row.executionFingerprint,
    state: row.state as AiOperationState,
    provider: row.provider,
    model: row.model,
    providerCapability:
      row.providerCapability as ProviderIdempotencyCapability,
    providerIdempotencyKey: row.providerIdempotencyKey,
    attemptCount: row.attemptCount,
    leaseOwner: row.leaseOwner,
    leaseUntil: row.leaseUntil,
    dispatchedAt: row.dispatchedAt,
    responseStatus: row.responseStatus,
    responseEnvelope: row.responseEnvelope,
    errorCode: row.errorCode,
    responseExpiresAt: row.responseExpiresAt,
  };
}
