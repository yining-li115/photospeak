import { randomUUID } from 'node:crypto';
import type { AiCapability } from './usage.js';
import {
  AiRequestHasher,
  AiResultVault,
  isSameHash,
} from './idempotency-crypto.js';
import {
  AiIdempotencyKeyValidationError,
  parseAiIdempotencyKey,
  shouldFenceUnknownAiIdempotencyKey,
} from './idempotency-key.js';
import type { ProviderIdempotencyCapability } from './types.js';

export type AiOperationState =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'rejected'
  | 'failed_final'
  | 'retryable'
  | 'uncertain'
  | 'recovery_fenced'
  | 'result_expired';

export interface AiOperationRecord {
  id: string;
  userId: string;
  capability: AiCapability;
  idempotencyKeyHash: string;
  idempotencyKeyVersion: 'legacy_uuid' | 'v2';
  dedupeExpiresAt: Date | null;
  requestHash: string;
  requestHashKeyId: string;
  contractVersion: number;
  executionFingerprint: string;
  state: AiOperationState;
  provider: string;
  model: string;
  providerCapability: ProviderIdempotencyCapability;
  providerIdempotencyKey: string;
  attemptCount: number;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  dispatchedAt: Date | null;
  responseStatus: number | null;
  responseEnvelope: string | null;
  errorCode: string | null;
  responseExpiresAt: Date | null;
}

export interface AiOperationStore {
  getOrCreate(input: {
    id: string;
    userId: string;
    capability: AiCapability;
    idempotencyKeyHash: string;
    idempotencyKeyVersion: 'legacy_uuid' | 'v2';
    dedupeExpiresAt: Date | null;
    requestHash: string;
    requestHashKeyId: string;
    contractVersion: number;
    executionFingerprint: string;
    provider: string;
    model: string;
    providerCapability: ProviderIdempotencyCapability;
    providerIdempotencyKey: string;
    initialState: 'pending' | 'recovery_fenced';
  }): Promise<{ operation: AiOperationRecord; created: boolean }>;
  get(id: string): Promise<AiOperationRecord | null>;
  claim(input: {
    id: string;
    expectedState: AiOperationState;
    workerId: string;
    now: Date;
    leaseUntil: Date;
  }): Promise<AiOperationRecord | null>;
  markDispatched(input: {
    id: string;
    workerId: string;
    now: Date;
  }): Promise<boolean>;
  complete(input: {
    id: string;
    workerId: string;
    state: 'succeeded' | 'rejected' | 'failed_final';
    responseStatus: number;
    responseEnvelope: string;
    errorCode?: string;
    responseExpiresAt: Date;
    now: Date;
  }): Promise<boolean>;
  markRetryable(input: {
    id: string;
    workerId: string;
    errorCode: string;
    now: Date;
    /** Set only when it is known that no provider work was accepted. */
    clearDispatch?: boolean;
  }): Promise<void>;
  markUncertain(input: {
    id: string;
    workerId?: string;
    errorCode: string;
    now: Date;
    onlyIfLeaseExpired?: boolean;
  }): Promise<void>;
  expireResults(now: Date): Promise<void>;
}

export interface StoredAiResponse {
  status: number;
  body: unknown;
  errorCode?: string;
}

export interface AiOperationResult<T = unknown> {
  status: number;
  body: T;
  operationId: string;
  replayed: boolean;
}

export class AiExecutionOutcomeUnknown extends Error {
  constructor(public readonly code = 'AI_PROVIDER_OUTCOME_UNKNOWN') {
    super('AI provider outcome is unknown');
    this.name = 'AiExecutionOutcomeUnknown';
  }
}

/** A provider call is known not to have executed; the same key may retry. */
export class AiExecutionDeferred extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly retryAfterSeconds?: number
  ) {
    super(code);
    this.name = 'AiExecutionDeferred';
  }
}

export class AiIdempotencyError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly operationId?: string,
    public readonly retryAfterSeconds?: number
  ) {
    super(code);
    this.name = 'AiIdempotencyError';
  }
}

export interface AiOperationServiceConfig {
  leaseMs?: number;
  analysisResultTtlMs?: number;
  speechResultTtlMs?: number;
  cleanupIntervalMs?: number;
  recoveryFenceCutoff?: Date | null;
  now?: () => Date;
}

export class AiOperationService {
  private readonly leaseMs: number;
  private readonly analysisResultTtlMs: number;
  private readonly speechResultTtlMs: number;
  private readonly cleanupIntervalMs: number;
  private readonly recoveryFenceCutoff: Date | null;
  private readonly now: () => Date;
  private lastCleanupAt = 0;
  private cleanupPromise: Promise<void> | null = null;

  constructor(
    private readonly store: AiOperationStore,
    private readonly hasher: AiRequestHasher,
    private readonly vault: AiResultVault,
    config: AiOperationServiceConfig = {}
  ) {
    this.leaseMs = config.leaseMs ?? 180_000;
    this.analysisResultTtlMs = config.analysisResultTtlMs ?? 72 * 60 * 60 * 1_000;
    this.speechResultTtlMs = config.speechResultTtlMs ?? 24 * 60 * 60 * 1_000;
    this.cleanupIntervalMs = config.cleanupIntervalMs ?? 60 * 60 * 1_000;
    this.recoveryFenceCutoff = config.recoveryFenceCutoff
      ? new Date(config.recoveryFenceCutoff)
      : null;
    if (
      this.recoveryFenceCutoff &&
      !Number.isFinite(this.recoveryFenceCutoff.getTime())
    ) {
      throw new Error('AI idempotency recovery fence cutoff is invalid');
    }
    this.now = config.now ?? (() => new Date());
  }

  async execute<T>(input: {
    userId: string;
    capability: AiCapability;
    idempotencyKey: string;
    request: unknown;
    contractVersion?: number;
    executionFingerprint: string;
    provider: string;
    model: string;
    providerCapability: ProviderIdempotencyCapability;
    prepare?: () => Promise<void>;
    execute: (context: {
      operationId: string;
      providerIdempotencyKey: string;
    }) => Promise<StoredAiResponse>;
  }): Promise<AiOperationResult<T>> {
    const now = this.now();
    let keyMetadata;
    try {
      keyMetadata = parseAiIdempotencyKey(input.idempotencyKey, now);
    } catch (error) {
      if (error instanceof AiIdempotencyKeyValidationError) {
        throw new AiIdempotencyError(error.code, error.status);
      }
      throw error;
    }
    await this.maybeCleanup(now);
    const contractVersion = input.contractVersion ?? 1;
    const idempotencyKeyHash = this.hasher.idempotencyKeyHash(input);
    const requestHashInput = {
      capability: input.capability,
      contractVersion,
      request: input.request,
    };
    const activeRequestHashKeyId = this.hasher.activeRequestHashKeyId;
    const activeRequestHash = this.hasher.requestHash(
      requestHashInput,
      activeRequestHashKeyId
    );
    const createdId = randomUUID();
    const { operation } = await this.store.getOrCreate({
      id: createdId,
      userId: input.userId,
      capability: input.capability,
      idempotencyKeyHash,
      idempotencyKeyVersion: keyMetadata.version,
      dedupeExpiresAt: keyMetadata.dedupeExpiresAt,
      requestHash: activeRequestHash,
      requestHashKeyId: activeRequestHashKeyId,
      contractVersion,
      executionFingerprint: input.executionFingerprint,
      provider: input.provider,
      model: input.model,
      providerCapability: input.providerCapability,
      providerIdempotencyKey: randomUUID(),
      initialState: shouldFenceUnknownAiIdempotencyKey(
        keyMetadata,
        this.recoveryFenceCutoff
      )
        ? 'recovery_fenced'
        : 'pending',
    });
    if (
      operation.idempotencyKeyVersion !== keyMetadata.version ||
      !sameOptionalDate(operation.dedupeExpiresAt, keyMetadata.dedupeExpiresAt)
    ) {
      throw new AiIdempotencyError(
        'AI_OPERATION_UNAVAILABLE',
        503,
        operation.id
      );
    }
    // Existing tombstones remain verifiable across active HMAC rotation. The
    // key that authenticated the original payload is part of the durable row;
    // a missing retired key fails closed before any provider can be called.
    const expectedRequestHash = this.hasher.requestHash(
      requestHashInput,
      operation.requestHashKeyId
    );
    if (!isSameHash(operation.requestHash, expectedRequestHash)) {
      throw new AiIdempotencyError(
        'IDEMPOTENCY_KEY_CONFLICT',
        409,
        operation.id
      );
    }
    return this.continueOperation<T>(
      operation,
      input.executionFingerprint,
      input.prepare,
      input.execute
    );
  }

  private async continueOperation<T>(
    operation: AiOperationRecord,
    executionFingerprint: string,
    prepare: (() => Promise<void>) | undefined,
    execute: (context: {
      operationId: string;
      providerIdempotencyKey: string;
    }) => Promise<StoredAiResponse>
  ): Promise<AiOperationResult<T>> {
    const now = this.now();
    if (
      operation.state === 'succeeded' ||
      operation.state === 'rejected' ||
      operation.state === 'failed_final'
    ) {
      if (
        !operation.responseEnvelope ||
        !operation.responseStatus ||
        !operation.responseExpiresAt ||
        operation.responseExpiresAt <= now
      ) {
        throw new AiIdempotencyError(
          'IDEMPOTENCY_RESULT_EXPIRED',
          410,
          operation.id
        );
      }
      return {
        status: operation.responseStatus,
        body: this.vault.open({
          operationId: operation.id,
          userId: operation.userId,
          capability: operation.capability,
          requestHash: operation.requestHash,
          envelope: operation.responseEnvelope,
        }) as T,
        operationId: operation.id,
        replayed: true,
      };
    }
    if (operation.state === 'result_expired') {
      throw new AiIdempotencyError(
        'IDEMPOTENCY_RESULT_EXPIRED',
        410,
        operation.id
      );
    }
    if (operation.state === 'recovery_fenced') {
      throw new AiIdempotencyError(
        'IDEMPOTENCY_RECOVERY_FENCE',
        410,
        operation.id
      );
    }
    if (operation.state === 'uncertain') {
      throw new AiIdempotencyError(
        'AI_OPERATION_UNCERTAIN',
        503,
        operation.id
      );
    }

    let expectedState = operation.state;
    if (operation.state === 'running') {
      if (operation.leaseUntil && operation.leaseUntil > now) {
        throw new AiIdempotencyError(
          'AI_OPERATION_IN_PROGRESS',
          409,
          operation.id,
          Math.max(1, Math.ceil((operation.leaseUntil.getTime() - now.getTime()) / 1_000))
        );
      }
      if (
        operation.dispatchedAt &&
        (operation.providerCapability !== 'native_replay' ||
          operation.executionFingerprint !== executionFingerprint)
      ) {
        await this.store.markUncertain({
          id: operation.id,
          errorCode: 'expired_lease_after_dispatch',
          now,
          onlyIfLeaseExpired: true,
        });
        throw new AiIdempotencyError(
          'AI_OPERATION_UNCERTAIN',
          503,
          operation.id
        );
      }
      expectedState = 'running';
    }

    if (operation.executionFingerprint !== executionFingerprint) {
      // A retry whose old provider may have accepted work cannot move to a
      // different adapter: the new provider cannot replay/query that work.
      if (operation.dispatchedAt) {
        throw new AiIdempotencyError(
          'AI_OPERATION_UNCERTAIN',
          503,
          operation.id
        );
      }
      throw new AiIdempotencyError(
        'AI_OPERATION_POLICY_CHANGED',
        409,
        operation.id
      );
    }

    const workerId = randomUUID();
    const claimed = await this.store.claim({
      id: operation.id,
      expectedState,
      workerId,
      now,
      leaseUntil: new Date(now.getTime() + this.leaseMs),
    });
    if (!claimed) {
      const fresh = await this.store.get(operation.id);
      if (!fresh) {
        throw new AiIdempotencyError('AI_OPERATION_UNAVAILABLE', 503);
      }
      return this.continueOperation<T>(
        fresh,
        executionFingerprint,
        prepare,
        execute
      );
    }

    try {
      await prepare?.();
    } catch (error) {
      const deferred =
        error instanceof AiExecutionDeferred
          ? error
          : new AiExecutionDeferred(
              'AI_EXECUTION_PREPARATION_FAILED',
              503,
              2
            );
      await this.store.markRetryable({
        id: claimed.id,
        workerId,
        errorCode: deferred.code,
        now: this.now(),
        clearDispatch: true,
      });
      throw new AiIdempotencyError(
        deferred.code,
        deferred.status,
        claimed.id,
        deferred.retryAfterSeconds
      );
    }

    // Crossing this line means the next awaited action can charge the account.
    // A crash after this durable marker must never auto-retry a provider whose
    // capability is `none`.
    const dispatched = await this.store.markDispatched({
      id: claimed.id,
      workerId,
      now: this.now(),
    });
    if (!dispatched) {
      throw new AiIdempotencyError(
        'AI_OPERATION_UNAVAILABLE',
        503,
        claimed.id
      );
    }

    let response: StoredAiResponse;
    try {
      response = await execute({
        operationId: claimed.id,
        providerIdempotencyKey: claimed.providerIdempotencyKey,
      });
    } catch (error) {
      if (error instanceof AiExecutionDeferred) {
        await this.store.markRetryable({
          id: claimed.id,
          workerId,
          errorCode: error.code,
          now: this.now(),
          clearDispatch: true,
        });
        throw new AiIdempotencyError(
          error.code,
          error.status,
          claimed.id,
          error.retryAfterSeconds
        );
      }
      const errorCode =
        error instanceof AiExecutionOutcomeUnknown
          ? error.code
          : 'AI_EXECUTION_INTERRUPTED';
      if (claimed.providerCapability === 'native_replay') {
        await this.store.markRetryable({
          id: claimed.id,
          workerId,
          errorCode,
          now: this.now(),
        });
        throw new AiIdempotencyError(
          'AI_OPERATION_RETRYABLE',
          503,
          claimed.id,
          2
        );
      }
      await this.store.markUncertain({
        id: claimed.id,
        workerId,
        errorCode,
        now: this.now(),
      });
      throw new AiIdempotencyError(
        'AI_OPERATION_UNCERTAIN',
        503,
        claimed.id
      );
    }

    const finishedAt = this.now();
    const terminalState =
      response.status < 400
        ? 'succeeded'
        : response.status === 422
          ? 'rejected'
          : 'failed_final';
    let envelope: string;
    try {
      envelope = this.vault.seal({
        operationId: claimed.id,
        userId: claimed.userId,
        capability: claimed.capability,
        requestHash: claimed.requestHash,
        value: response.body,
      });
    } catch {
      await this.store
        .markUncertain({
          id: claimed.id,
          workerId,
          errorCode: 'result_encryption_failed',
          now: this.now(),
        })
        .catch(() => {});
      throw new AiIdempotencyError(
        'AI_OPERATION_UNCERTAIN',
        503,
        claimed.id
      );
    }
    const responseTtl =
      claimed.capability === 'speech_synthesis'
        ? this.speechResultTtlMs
        : this.analysisResultTtlMs;
    let completed = false;
    try {
      completed = await this.store.complete({
        id: claimed.id,
        workerId,
        state: terminalState,
        responseStatus: response.status,
        responseEnvelope: envelope,
        errorCode: response.errorCode,
        responseExpiresAt: new Date(finishedAt.getTime() + responseTtl),
        now: finishedAt,
      });
    } catch {
      completed = false;
    }
    if (!completed) {
      await this.store
        .markUncertain({
          id: claimed.id,
          workerId,
          errorCode: 'result_commit_failed',
          now: this.now(),
        })
        .catch(() => {});
      throw new AiIdempotencyError(
        'AI_OPERATION_UNCERTAIN',
        503,
        claimed.id
      );
    }
    return {
      status: response.status,
      body: response.body as T,
      operationId: claimed.id,
      replayed: false,
    };
  }

  private async maybeCleanup(now: Date): Promise<void> {
    if (now.getTime() - this.lastCleanupAt < this.cleanupIntervalMs) return;
    if (this.cleanupPromise) return this.cleanupPromise;
    this.lastCleanupAt = now.getTime();
    const cleanup = this.store.expireResults(now).catch((error) => {
        console.error(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: 'ai.idempotency.cleanup_failed',
            message: error instanceof Error ? error.message : String(error),
          })
        );
      });
    const tracked = cleanup.finally(() => {
      if (this.cleanupPromise === tracked) this.cleanupPromise = null;
    });
    this.cleanupPromise = tracked;
    return tracked;
  }
}

function sameOptionalDate(left: Date | null, right: Date | null): boolean {
  return left === null
    ? right === null
    : right !== null && left.getTime() === right.getTime();
}
