import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AiRequestHasher,
  AiResultVault,
  missingRequestHashKeyIds,
  parseAiCryptoConfig,
} from './idempotency-crypto.js';
import {
  AiExecutionDeferred,
  AiExecutionOutcomeUnknown,
  AiIdempotencyError,
  AiOperationService,
  type AiOperationRecord,
  type AiOperationState,
  type AiOperationStore,
} from './idempotency.js';
import {
  AI_IDEMPOTENCY_KEY_FUTURE_SKEW_MS,
  parseAiRecoveryFenceCutoff,
} from './idempotency-key.js';

function fixtures(config: ConstructorParameters<typeof AiOperationService>[3] = {}) {
  const store = new MemoryStore();
  return {
    store,
    service: createTestService(store, config),
  };
}

function createTestService(
  store: AiOperationStore,
  config: ConstructorParameters<typeof AiOperationService>[3] = {}
): AiOperationService {
  const crypto = parseAiCryptoConfig({
    activeKeyId: 'test',
    keyRingJson: JSON.stringify({
      test: Buffer.alloc(32, 7).toString('base64'),
    }),
    activeHmacKeyId: 'test',
    hmacKeyRingJson: JSON.stringify({
      test: Buffer.alloc(32, 9).toString('base64'),
    }),
  });
  return new AiOperationService(
    store,
    new AiRequestHasher(crypto.activeHmacKeyId, crypto.hmacKeys),
    new AiResultVault(crypto),
    { cleanupIntervalMs: Number.MAX_SAFE_INTEGER, ...config }
  );
}

const base = {
  userId: 'user-1',
  capability: 'speech_synthesis' as const,
  idempotencyKey: '12345678-1234-4234-9234-123456789abc',
  request: { text: 'hello', style: 'neutral' },
  executionFingerprint: 'v1:speech:test:model:voice',
  provider: 'test',
  model: 'model',
  providerCapability: 'none' as const,
};

test('concurrent and later replays invoke the provider once', async () => {
  const { service } = fixtures();
  let providerCalls = 0;
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => (started = resolve));
  const blocker = new Promise<void>((resolve) => (release = resolve));
  const first = service.execute({
    ...base,
    execute: async () => {
      providerCalls += 1;
      started();
      await blocker;
      return { status: 200, body: { audio: 'stable' } };
    },
  });
  await startedPromise;
  await assert.rejects(
    service.execute({
      ...base,
      execute: async () => {
        providerCalls += 1;
        return { status: 200, body: { audio: 'duplicate' } };
      },
    }),
    (error) =>
      error instanceof AiIdempotencyError &&
      error.code === 'AI_OPERATION_IN_PROGRESS'
  );
  release();
  const firstResult = await first;
  const replay = await service.execute({
    ...base,
    execute: async () => {
      providerCalls += 1;
      return { status: 200, body: { audio: 'duplicate' } };
    },
  });
  assert.equal(providerCalls, 1);
  assert.deepEqual(replay.body, firstResult.body);
  assert.equal(replay.replayed, true);
  assert.equal(replay.operationId, firstResult.operationId);
});

test('one key cannot be reused with a different validated payload', async () => {
  const { service } = fixtures();
  await service.execute({
    ...base,
    execute: async () => ({ status: 200, body: { ok: true } }),
  });
  await assert.rejects(
    service.execute({
      ...base,
      request: { text: 'different', style: 'neutral' },
      execute: async () => ({ status: 200, body: { ok: false } }),
    }),
    (error) =>
      error instanceof AiIdempotencyError &&
      error.code === 'IDEMPOTENCY_KEY_CONFLICT'
  );
});

test('unknown outcome with a non-idempotent provider fails closed', async () => {
  const { service } = fixtures();
  let calls = 0;
  const invoke = () =>
    service.execute({
      ...base,
      execute: async () => {
        calls += 1;
        throw new AiExecutionOutcomeUnknown('provider_timeout');
      },
    });
  await assert.rejects(
    invoke(),
    (error) =>
      error instanceof AiIdempotencyError &&
      error.code === 'AI_OPERATION_UNCERTAIN'
  );
  await assert.rejects(
    invoke(),
    (error) =>
      error instanceof AiIdempotencyError &&
      error.code === 'AI_OPERATION_UNCERTAIN'
  );
  assert.equal(calls, 1);
});

test('an uncertain non-idempotent operation stays locked beyond one year', async () => {
  let now = new Date('2026-01-01T00:00:00.000Z');
  const { service, store } = fixtures({ now: () => now });
  let calls = 0;
  const invoke = () =>
    service.execute({
      ...base,
      execute: async () => {
        calls += 1;
        throw new AiExecutionOutcomeUnknown('provider_response_lost');
      },
    });
  await assert.rejects(invoke());
  now = new Date(now.getTime() + 366 * 24 * 60 * 60 * 1_000);
  await store.expireResults(now);
  await assert.rejects(
    invoke(),
    (error) =>
      error instanceof AiIdempotencyError &&
      error.code === 'AI_OPERATION_UNCERTAIN'
  );
  assert.equal(calls, 1);
  assert.equal(store.all().length, 1);
});

test('a pre-dispatch failure is retryable and never invokes the provider', async () => {
  const { service, store } = fixtures();
  let providerCalls = 0;
  await assert.rejects(
    service.execute({
      ...base,
      prepare: async () => {
        throw new AiExecutionDeferred('AI_COST_CHECK_UNAVAILABLE', 503, 5);
      },
      execute: async () => {
        providerCalls += 1;
        return { status: 200, body: { audio: 'never' } };
      },
    }),
    (error) =>
      error instanceof AiIdempotencyError &&
      error.code === 'AI_COST_CHECK_UNAVAILABLE'
  );
  assert.equal(providerCalls, 0);
  const [operation] = store.all();
  assert.equal(operation.state, 'retryable');
  assert.equal(operation.dispatchedAt, null);
});

test('an unfinished key never crosses an execution-policy change silently', async () => {
  const { service } = fixtures();
  let providerCalls = 0;
  await assert.rejects(
    service.execute({
      ...base,
      prepare: async () => {
        throw new AiExecutionDeferred('AI_BUSY', 503, 5);
      },
      execute: async () => {
        providerCalls += 1;
        return { status: 200, body: { audio: 'never' } };
      },
    })
  );
  await assert.rejects(
    service.execute({
      ...base,
      executionFingerprint: 'v2:speech:new-provider:new-model:voice',
      execute: async () => {
        providerCalls += 1;
        return { status: 200, body: { audio: 'changed' } };
      },
    }),
    (error) =>
      error instanceof AiIdempotencyError &&
      error.code === 'AI_OPERATION_POLICY_CHANGED'
  );
  assert.equal(providerCalls, 0);
});

test('expired encrypted results return 410 and never call the provider', async () => {
  let now = new Date('2026-01-01T00:00:00.000Z');
  const { service } = fixtures({
    now: () => now,
    speechResultTtlMs: 1_000,
  });
  let calls = 0;
  const execute = async () => {
    calls += 1;
    return { status: 200, body: { audio: 'one' } };
  };
  await service.execute({ ...base, execute });
  now = new Date(now.getTime() + 1_001);
  await assert.rejects(
    service.execute({ ...base, execute }),
    (error) =>
      error instanceof AiIdempotencyError &&
      error.code === 'IDEMPOTENCY_RESULT_EXPIRED' &&
      error.status === 410
  );
  assert.equal(calls, 1);
});

test('an old key remains a non-executable tombstone for the account lifetime', async () => {
  let now = new Date('2026-01-01T00:00:00.000Z');
  const { service, store } = fixtures({
    now: () => now,
    speechResultTtlMs: 1_000,
  });
  let calls = 0;
  const execute = async () => {
    calls += 1;
    return { status: 200, body: { audio: 'once' } };
  };
  await service.execute({ ...base, execute });
  now = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1_000);
  await store.expireResults(now);

  await assert.rejects(
    service.execute({ ...base, execute }),
    (error) =>
      error instanceof AiIdempotencyError &&
      error.code === 'IDEMPOTENCY_RESULT_EXPIRED'
  );
  assert.equal(calls, 1);
  assert.equal(store.all().length, 1);
  assert.equal(store.all()[0].state, 'result_expired');
});

test('rotating the active request HMAC key cannot bypass a year-old tombstone', async () => {
  let now = new Date('2026-01-01T00:00:00.000Z');
  const versionedKey = `v2.${Math.floor(now.getTime() / 1_000)}.12345678-1234-4234-9234-123456789abc`;
  const store = new MemoryStore();
  const encryptionKey = Buffer.alloc(32, 7).toString('base64');
  const oldRequestKey = Buffer.alloc(32, 8).toString('base64');
  const newRequestKey = Buffer.alloc(32, 9).toString('base64');
  const requestKeyRing = JSON.stringify({
    old: oldRequestKey,
    new: newRequestKey,
  });
  const oldCrypto = parseAiCryptoConfig({
    activeKeyId: 'result',
    keyRingJson: JSON.stringify({ result: encryptionKey }),
    activeHmacKeyId: 'old',
    hmacKeyRingJson: requestKeyRing,
  });
  const newCrypto = parseAiCryptoConfig({
    activeKeyId: 'result',
    keyRingJson: JSON.stringify({ result: encryptionKey }),
    activeHmacKeyId: 'new',
    hmacKeyRingJson: requestKeyRing,
  });
  const serviceFor = (crypto: typeof oldCrypto) =>
    new AiOperationService(
      store,
      new AiRequestHasher(crypto.activeHmacKeyId, crypto.hmacKeys),
      new AiResultVault(crypto),
      {
        now: () => now,
        speechResultTtlMs: 1_000,
        cleanupIntervalMs: Number.MAX_SAFE_INTEGER,
      }
    );
  let providerCalls = 0;
  const execute = async () => {
    providerCalls += 1;
    return { status: 200, body: { audio: 'once' } };
  };

  await serviceFor(oldCrypto).execute({
    ...base,
    idempotencyKey: versionedKey,
    execute,
  });
  now = new Date(now.getTime() + 366 * 24 * 60 * 60 * 1_000);
  await store.expireResults(now);
  await assert.rejects(
    serviceFor(newCrypto).execute({
      ...base,
      idempotencyKey: versionedKey,
      execute,
    }),
    (error) =>
      error instanceof AiIdempotencyError &&
      error.code === 'IDEMPOTENCY_RESULT_EXPIRED'
  );

  assert.equal(providerCalls, 1);
  assert.equal(store.all().length, 1);
  assert.equal(store.all()[0].requestHashKeyId, 'old');
});

test('a purged versioned tombstone stays non-executable after its key horizon', async () => {
  let now = new Date('2026-01-01T00:00:00.000Z');
  const { service, store } = fixtures({ now: () => now });
  const idempotencyKey =
    `v2.${Math.floor(now.getTime() / 1_000)}.12345678-1234-4234-9234-123456789abc`;
  let providerCalls = 0;
  const execute = async () => {
    providerCalls += 1;
    return { status: 200, body: { audio: 'once' } };
  };
  await service.execute({ ...base, idempotencyKey, execute });

  now = new Date(now.getTime() + 408 * 24 * 60 * 60 * 1_000);
  store.purgeDedupeExpiredBefore(
    new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000)
  );
  assert.equal(store.all().length, 0);
  await assert.rejects(
    service.execute({ ...base, idempotencyKey, execute }),
    (error) =>
      error instanceof AiIdempotencyError &&
      error.code === 'IDEMPOTENCY_KEY_EXPIRED' &&
      error.status === 410
  );
  assert.equal(providerCalls, 1);
  assert.equal(store.all().length, 0);
});

test('startup key-ring validation rejects missing referenced HMAC keys', () => {
  assert.deepEqual(
    missingRequestHashKeyIds(
      ['old', 'active', 'old'],
      new Set(['active'])
    ),
    ['old']
  );
});

test('a restore fence turns a missing pre-cutoff v2 key into a durable 410 tombstone', async () => {
  let now = new Date('2026-01-01T12:00:00.000Z');
  const cutoff = new Date('2026-01-02T00:00:00.000Z');
  const idempotencyKey =
    `v2.${Math.floor(now.getTime() / 1_000)}.12345678-1234-4234-9234-123456789abc`;
  const store = new MemoryStore();
  let providerCalls = 0;
  const execute = async () => {
    providerCalls += 1;
    return { status: 200, body: { audio: 'charged-before-backup-restore' } };
  };

  await createTestService(store, { now: () => now }).execute({
    ...base,
    idempotencyKey,
    execute,
  });
  store.simulateRestoreLoss();
  now = new Date('2026-01-02T00:05:00.000Z');
  const recoveredService = createTestService(store, {
    now: () => now,
    recoveryFenceCutoff: cutoff,
  });
  const retry = () =>
    recoveredService.execute({ ...base, idempotencyKey, execute });

  await assert.rejects(
    retry(),
    (error) =>
      error instanceof AiIdempotencyError &&
      error.code === 'IDEMPOTENCY_RECOVERY_FENCE' &&
      error.status === 410
  );
  await assert.rejects(
    retry(),
    (error) =>
      error instanceof AiIdempotencyError &&
      error.code === 'IDEMPOTENCY_RECOVERY_FENCE'
  );
  assert.equal(providerCalls, 1);
  assert.equal(store.all().length, 1);
  assert.equal(store.all()[0].state, 'recovery_fenced');
});

test('a restore fence covers the maximum accepted client clock skew', async () => {
  const cutoff = new Date('2026-01-02T00:00:00.000Z');
  let now = new Date(cutoff.getTime() - 1_000);
  const fastDeviceTimestamp =
    now.getTime() + AI_IDEMPOTENCY_KEY_FUTURE_SKEW_MS;
  const idempotencyKey =
    `v2.${Math.floor(fastDeviceTimestamp / 1_000)}.12345678-1234-4234-9234-123456789abc`;
  const store = new MemoryStore();
  let providerCalls = 0;
  const execute = async () => {
    providerCalls += 1;
    return { status: 200, body: { audio: 'charged-before-restore' } };
  };

  // The key is valid immediately before the incident even though this device
  // clock is at the protocol's maximum accepted lead.
  await createTestService(store, { now: () => now }).execute({
    ...base,
    idempotencyKey,
    execute,
  });
  store.simulateRestoreLoss();

  now = new Date(cutoff.getTime() + 60_000);
  await assert.rejects(
    createTestService(store, {
      now: () => now,
      recoveryFenceCutoff: cutoff,
    }).execute({ ...base, idempotencyKey, execute }),
    (error) =>
      error instanceof AiIdempotencyError &&
      error.code === 'IDEMPOTENCY_RECOVERY_FENCE' &&
      error.status === 410
  );
  assert.equal(providerCalls, 1);
  assert.equal(store.all()[0].state, 'recovery_fenced');
});

test('a restore fence preserves known operations and permits keys after its skew window', async () => {
  let now = new Date('2026-01-01T12:00:00.000Z');
  const cutoff = new Date('2026-01-02T00:00:00.000Z');
  const oldKey =
    `v2.${Math.floor(now.getTime() / 1_000)}.12345678-1234-4234-9234-123456789abc`;
  const store = new MemoryStore();
  let providerCalls = 0;
  const execute = async () => {
    providerCalls += 1;
    return { status: 200, body: { audio: `call-${providerCalls}` } };
  };
  await createTestService(store, { now: () => now }).execute({
    ...base,
    idempotencyKey: oldKey,
    execute,
  });

  now = new Date(
    cutoff.getTime() + AI_IDEMPOTENCY_KEY_FUTURE_SKEW_MS + 60_000
  );
  const recoveredService = createTestService(store, {
    now: () => now,
    recoveryFenceCutoff: cutoff,
  });
  const replay = await recoveredService.execute({
    ...base,
    idempotencyKey: oldKey,
    execute,
  });
  assert.equal(replay.replayed, true);

  const newKey =
    `v2.${Math.floor(now.getTime() / 1_000)}.22345678-1234-4234-9234-123456789abc`;
  await recoveredService.execute({
    ...base,
    idempotencyKey: newKey,
    execute,
  });
  assert.equal(providerCalls, 2);
});

test('an active restore fence fails closed for an unknown legacy UUID', async () => {
  const now = new Date('2026-01-02T00:05:00.000Z');
  const { service, store } = fixtures({
    now: () => now,
    recoveryFenceCutoff: new Date('2026-01-02T00:00:00.000Z'),
  });
  let providerCalls = 0;
  await assert.rejects(
    service.execute({
      ...base,
      execute: async () => {
        providerCalls += 1;
        return { status: 200, body: { audio: 'must-not-run' } };
      },
    }),
    (error) =>
      error instanceof AiIdempotencyError &&
      error.code === 'IDEMPOTENCY_RECOVERY_FENCE'
  );
  assert.equal(providerCalls, 0);
  assert.equal(store.all()[0].state, 'recovery_fenced');
});

test('recovery fence configuration accepts UTC and rejects ambiguous timestamps', () => {
  const now = new Date('2026-01-02T00:00:00.000Z');
  assert.equal(
    parseAiRecoveryFenceCutoff('2026-01-01T23:59:00Z', now)?.toISOString(),
    '2026-01-01T23:59:00.000Z'
  );
  assert.equal(parseAiRecoveryFenceCutoff('  ', now), null);
  assert.throws(() =>
    parseAiRecoveryFenceCutoff('2026-01-01 23:59:00', now)
  );
  assert.throws(() =>
    parseAiRecoveryFenceCutoff('2027-01-01T00:00:00Z', now)
  );
});

class MemoryStore implements AiOperationStore {
  private readonly rows = new Map<string, AiOperationRecord>();
  private readonly unique = new Map<string, string>();

  async getOrCreate(
    input: Parameters<AiOperationStore['getOrCreate']>[0]
  ): Promise<{ operation: AiOperationRecord; created: boolean }> {
    const key = `${input.userId}:${input.capability}:${input.idempotencyKeyHash}`;
    const existingId = this.unique.get(key);
    if (existingId) {
      return { operation: this.copy(this.rows.get(existingId)!), created: false };
    }
    const { initialState, ...recordInput } = input;
    const operation: AiOperationRecord = {
      ...recordInput,
      state: initialState,
      attemptCount: 0,
      leaseOwner: null,
      leaseUntil: null,
      dispatchedAt: null,
      responseStatus: null,
      responseEnvelope: null,
      errorCode:
        initialState === 'recovery_fenced'
          ? 'recovery_fence_unknown_key'
          : null,
      responseExpiresAt: null,
    };
    this.rows.set(operation.id, operation);
    this.unique.set(key, operation.id);
    return { operation: this.copy(operation), created: true };
  }

  async get(id: string): Promise<AiOperationRecord | null> {
    const row = this.rows.get(id);
    return row ? this.copy(row) : null;
  }

  async claim(input: {
    id: string;
    expectedState: AiOperationState;
    workerId: string;
    now: Date;
    leaseUntil: Date;
  }): Promise<AiOperationRecord | null> {
    const row = this.rows.get(input.id);
    if (!row || row.state !== input.expectedState) return null;
    if (
      input.expectedState === 'running' &&
      row.leaseUntil &&
      row.leaseUntil > input.now
    ) {
      return null;
    }
    Object.assign(row, {
      state: 'running',
      leaseOwner: input.workerId,
      leaseUntil: input.leaseUntil,
      attemptCount: row.attemptCount + 1,
    });
    return this.copy(row);
  }

  async markDispatched(input: {
    id: string;
    workerId: string;
    now: Date;
  }): Promise<boolean> {
    const row = this.rows.get(input.id);
    if (!row || row.state !== 'running' || row.leaseOwner !== input.workerId) {
      return false;
    }
    row.dispatchedAt = input.now;
    return true;
  }

  async complete(
    input: Parameters<AiOperationStore['complete']>[0]
  ): Promise<boolean> {
    const row = this.rows.get(input.id);
    if (!row || row.state !== 'running' || row.leaseOwner !== input.workerId) {
      return false;
    }
    Object.assign(row, {
      state: input.state,
      responseStatus: input.responseStatus,
      responseEnvelope: input.responseEnvelope,
      responseExpiresAt: input.responseExpiresAt,
      errorCode: input.errorCode ?? null,
      leaseOwner: null,
      leaseUntil: null,
    });
    return true;
  }

  async markRetryable(
    input: Parameters<AiOperationStore['markRetryable']>[0]
  ): Promise<void> {
    const row = this.rows.get(input.id);
    if (row?.state === 'running' && row.leaseOwner === input.workerId) {
      Object.assign(row, {
        state: 'retryable',
        errorCode: input.errorCode,
        leaseOwner: null,
        leaseUntil: null,
        ...(input.clearDispatch ? { dispatchedAt: null } : {}),
      });
    }
  }

  async markUncertain(
    input: Parameters<AiOperationStore['markUncertain']>[0]
  ): Promise<void> {
    const row = this.rows.get(input.id);
    if (!row || row.state !== 'running') return;
    if (input.workerId && row.leaseOwner !== input.workerId) return;
    if (
      input.onlyIfLeaseExpired &&
      row.leaseUntil &&
      row.leaseUntil > input.now
    ) {
      return;
    }
    Object.assign(row, {
      state: 'uncertain',
      errorCode: input.errorCode,
      leaseOwner: null,
      leaseUntil: null,
    });
  }

  async expireResults(now: Date): Promise<void> {
    for (const row of this.rows.values()) {
      if (row.responseExpiresAt && row.responseExpiresAt <= now) {
        row.state = 'result_expired';
        row.responseEnvelope = null;
      }
    }
  }

  all(): AiOperationRecord[] {
    return [...this.rows.values()].map((row) => this.copy(row));
  }

  purgeDedupeExpiredBefore(cutoff: Date): void {
    for (const [id, row] of this.rows) {
      if (
        row.state !== 'running' &&
        row.dedupeExpiresAt &&
        row.dedupeExpiresAt <= cutoff
      ) {
        this.rows.delete(id);
        this.unique.delete(
          `${row.userId}:${row.capability}:${row.idempotencyKeyHash}`
        );
      }
    }
  }

  simulateRestoreLoss(): void {
    this.rows.clear();
    this.unique.clear();
  }

  private copy(row: AiOperationRecord): AiOperationRecord {
    return { ...row };
  }
}
