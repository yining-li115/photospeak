import * as Crypto from 'expo-crypto';
import { formatAiIdempotencyKey } from '../api/idempotency-key';
import { requireCurrentOwner } from './owner';
import { getDB } from './schema';
import { ensureDatabaseWriteCapacity } from '../storage/quota';
import { resolveStoragePath, toRelativeStoragePath } from '../storage/resolve';

export type AiIntentCapability =
  | 'session_analysis'
  | 'follow_up'
  | 'speech_synthesis';

export interface AiOperationIntent {
  ownerUserId: string;
  sessionId: string;
  capability: AiIntentCapability;
  logicalKey: string;
  requestHash: string;
  idempotencyKey: string;
  state: 'pending' | 'completed';
  localResultUri: string | null;
}

interface IntentRow {
  owner_user_id: string;
  session_id: string;
  capability: AiIntentCapability;
  logical_key: string;
  request_hash: string;
  idempotency_key: string;
  state: 'pending' | 'completed';
  local_result_uri: string | null;
}

export interface AbandonedCompletedSpeechIntent {
  ownerUserId: string;
  sessionId: string;
  logicalKey: string;
  idempotencyKey: string;
  storedLocalResultPath: string;
  localResultPath: string;
  updatedAt: string;
}

/**
 * Atomically persist retry identity before a billable request begins. The key
 * is not a credential, but remains owner-scoped so accounts never share work.
 */
export async function getOrCreateAiIntent(input: {
  sessionId: string;
  capability: AiIntentCapability;
  logicalKey: string;
  requestHash: string;
  expectedOwner?: string;
}): Promise<AiOperationIntent> {
  const owner = requireCurrentOwner();
  if (input.expectedOwner && input.expectedOwner !== owner) {
    throw new Error('The signed-in account changed before the AI request');
  }
  if (!input.logicalKey || input.logicalKey.length > 300) {
    throw new Error('AI operation logical key is invalid');
  }
  if (!input.sessionId || input.sessionId.length > 128) {
    throw new Error('AI operation session identifier is invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(input.requestHash)) {
    throw new Error('AI operation request hash is invalid');
  }
  const db = await getDB();
  const existing = await db.getFirstAsync<IntentRow>(
    `SELECT owner_user_id, session_id, capability, logical_key, request_hash,
            idempotency_key, state, local_result_uri
     FROM ai_operation_intents
     WHERE owner_user_id = ? AND capability = ? AND logical_key = ?`,
    [owner, input.capability, input.logicalKey]
  );
  if (existing) {
    assertMatchingIntent(existing, input.sessionId, input.requestHash);
    return mapIntent(existing);
  }

  const idempotencyKey = createAiIdempotencyKey();
  const now = new Date().toISOString();
  // This row must be durable before a billable request can leave the device.
  // Include every inserted value so SQLite, indexes and WAL growth are covered.
  ensureDatabaseWriteCapacity([
    owner,
    input.sessionId,
    input.capability,
    input.logicalKey,
    input.requestHash,
    idempotencyKey,
    'pending',
    now,
    now,
  ]);
  let row: IntentRow | null = null;
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      `INSERT OR IGNORE INTO ai_operation_intents (
         owner_user_id, session_id, capability, logical_key, request_hash,
         idempotency_key, state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        owner,
        input.sessionId,
        input.capability,
        input.logicalKey,
        input.requestHash,
        idempotencyKey,
        now,
        now,
      ]
    );
    row = await txn.getFirstAsync<IntentRow>(
      `SELECT owner_user_id, session_id, capability, logical_key, request_hash,
              idempotency_key, state, local_result_uri
       FROM ai_operation_intents
       WHERE owner_user_id = ? AND capability = ? AND logical_key = ?`,
      [owner, input.capability, input.logicalKey]
    );
    if (!row) throw new Error('AI operation intent could not be persisted');
    assertMatchingIntent(row, input.sessionId, input.requestHash);
  });
  return mapIntent(row!);
}

export async function markAiIntentCompleted(input: {
  capability: AiIntentCapability;
  logicalKey: string;
  idempotencyKey: string;
  localResultUri?: string;
  expectedOwner?: string;
}): Promise<void> {
  const owner = requireCurrentOwner();
  if (input.expectedOwner && input.expectedOwner !== owner) {
    throw new Error('The signed-in account changed before AI result commit');
  }
  const now = new Date().toISOString();
  const db = await getDB();
  const result = await db.runAsync(
    `UPDATE ai_operation_intents
     SET state = 'completed', local_result_uri = ?, completed_at = ?,
         updated_at = ?
     WHERE owner_user_id = ? AND capability = ? AND logical_key = ?
       AND idempotency_key = ?`,
    [
      input.localResultUri
        ? toRelativeStoragePath(input.localResultUri)
        : null,
      now,
      now,
      owner,
      input.capability,
      input.logicalKey,
      input.idempotencyKey,
    ]
  );
  if (result.changes !== 1) {
    throw new Error('AI operation intent no longer matches this result');
  }
}

/** Remove only a result whose durable local consumer has already committed. */
export async function deleteCompletedAiIntent(input: {
  sessionId: string;
  capability: AiIntentCapability;
  logicalKey: string;
  idempotencyKey: string;
  expectedOwner?: string;
}): Promise<void> {
  const owner = requireCurrentOwner();
  if (input.expectedOwner && input.expectedOwner !== owner) {
    throw new Error('The signed-in account changed before AI intent cleanup');
  }
  const db = await getDB();
  await db.runAsync(
    `DELETE FROM ai_operation_intents
     WHERE owner_user_id = ? AND session_id = ? AND capability = ?
       AND logical_key = ? AND idempotency_key = ? AND state = 'completed'`,
    [
      owner,
      input.sessionId,
      input.capability,
      input.logicalKey,
      input.idempotencyKey,
    ]
  );
}

/**
 * Find old sentence checkpoints whose draft was never committed as a session.
 * Pending rows deliberately remain durable: they may represent a charged or
 * uncertain provider call and must retain their idempotency key.
 */
export async function listAbandonedCompletedSpeechIntents(
  updatedBeforeOrAt: string
): Promise<AbandonedCompletedSpeechIntent[]> {
  const db = await getDB();
  const rows = await db.getAllAsync<{
    owner_user_id: string;
    session_id: string;
    logical_key: string;
    idempotency_key: string;
    local_result_uri: string;
    updated_at: string;
  }>(
    `SELECT intent.owner_user_id, intent.session_id, intent.logical_key,
            intent.idempotency_key, intent.local_result_uri, intent.updated_at
     FROM ai_operation_intents AS intent
     WHERE intent.capability = 'speech_synthesis'
       AND intent.state = 'completed'
       AND intent.local_result_uri IS NOT NULL
       AND intent.updated_at <= ?
       AND NOT EXISTS (
         SELECT 1 FROM sessions AS session
         WHERE session.owner_user_id = intent.owner_user_id
           AND session.id = intent.session_id
       )`,
    [updatedBeforeOrAt]
  );
  return rows.map((row) => ({
    ownerUserId: row.owner_user_id,
    sessionId: row.session_id,
    logicalKey: row.logical_key,
    idempotencyKey: row.idempotency_key,
    storedLocalResultPath: row.local_result_uri,
    localResultPath: toRelativeStoragePath(row.local_result_uri),
    updatedAt: row.updated_at,
  }));
}

/**
 * Delete the checkpoint metadata only after maintenance has removed (or
 * confirmed absence of) its managed media. Every predicate is rechecked so a
 * session committed since the scan protects its row.
 */
export async function deleteAbandonedCompletedSpeechIntent(
  intent: AbandonedCompletedSpeechIntent,
  updatedBeforeOrAt: string
): Promise<boolean> {
  const db = await getDB();
  const result = await db.runAsync(
    `DELETE FROM ai_operation_intents
     WHERE owner_user_id = ? AND session_id = ?
       AND capability = 'speech_synthesis' AND logical_key = ?
       AND idempotency_key = ? AND state = 'completed'
       AND local_result_uri = ? AND updated_at = ? AND updated_at <= ?
       AND NOT EXISTS (
         SELECT 1 FROM sessions
         WHERE sessions.owner_user_id = ai_operation_intents.owner_user_id
           AND sessions.id = ai_operation_intents.session_id
       )`,
    [
      intent.ownerUserId,
      intent.sessionId,
      intent.logicalKey,
      intent.idempotencyKey,
      intent.storedLocalResultPath,
      intent.updatedAt,
      updatedBeforeOrAt,
    ]
  );
  return result.changes === 1;
}

export async function markAiIntentPending(input: {
  capability: AiIntentCapability;
  logicalKey: string;
  idempotencyKey: string;
  expectedOwner?: string;
}): Promise<void> {
  const owner = requireCurrentOwner();
  if (input.expectedOwner && input.expectedOwner !== owner) {
    throw new Error('The signed-in account changed before AI recovery');
  }
  const db = await getDB();
  await db.runAsync(
    `UPDATE ai_operation_intents
     SET state = 'pending', local_result_uri = NULL, completed_at = NULL,
         updated_at = ?
     WHERE owner_user_id = ? AND capability = ? AND logical_key = ?
       AND idempotency_key = ?`,
    [
      new Date().toISOString(),
      owner,
      input.capability,
      input.logicalKey,
      input.idempotencyKey,
    ]
  );
}

/** Only call after the user explicitly accepts a newly billable operation. */
export async function rotateAiIntentAfterExplicitRestart(input: {
  sessionId: string;
  capability: AiIntentCapability;
  logicalKey: string;
  requestHash: string;
  previousIdempotencyKey: string;
  expectedOwner?: string;
}): Promise<AiOperationIntent> {
  const owner = requireCurrentOwner();
  if (input.expectedOwner && input.expectedOwner !== owner) {
    throw new Error('The signed-in account changed before AI restart');
  }
  const nextKey = createAiIdempotencyKey();
  const now = new Date().toISOString();
  const db = await getDB();
  const result = await db.runAsync(
    `UPDATE ai_operation_intents
     SET idempotency_key = ?, state = 'pending', local_result_uri = NULL,
         completed_at = NULL, updated_at = ?
     WHERE owner_user_id = ? AND session_id = ? AND capability = ?
       AND logical_key = ?
       AND request_hash = ? AND idempotency_key = ?`,
    [
      nextKey,
      now,
      owner,
      input.sessionId,
      input.capability,
      input.logicalKey,
      input.requestHash,
      input.previousIdempotencyKey,
    ]
  );
  if (result.changes !== 1) {
    throw new Error('AI operation changed before explicit restart');
  }
  return {
    ownerUserId: owner,
    sessionId: input.sessionId,
    capability: input.capability,
    logicalKey: input.logicalKey,
    requestHash: input.requestHash,
    idempotencyKey: nextKey,
    state: 'pending',
    localResultUri: null,
  };
}

export async function hashAiRequest(value: unknown): Promise<string> {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    canonicalJson(value)
  );
}

export function aiLogicalKey(
  scope: string,
  requestHash: string
): string {
  if (!scope || scope.length > 220 || !/^[a-f0-9]{64}$/.test(requestHash)) {
    throw new Error('AI logical operation input is invalid');
  }
  return `${scope}:${requestHash}`;
}

function mapIntent(row: IntentRow): AiOperationIntent {
  return {
    ownerUserId: row.owner_user_id,
    sessionId: row.session_id,
    capability: row.capability,
    logicalKey: row.logical_key,
    requestHash: row.request_hash,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    localResultUri: row.local_result_uri
      ? resolveStoragePath(row.local_result_uri)
      : null,
  };
}

function assertMatchingIntent(
  row: IntentRow,
  sessionId: string,
  requestHash: string
): void {
  if (row.session_id !== sessionId || row.request_hash !== requestHash) {
    throw new Error('AI operation intent payload changed unexpectedly');
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid AI request number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('Unsupported AI request value');
}

/**
 * The embedded issue time lets the server reject an old key even after its
 * bounded tombstone has been purged. UUID-only beta rows remain supported by
 * the server as non-expiring legacy keys.
 */
function createAiIdempotencyKey(nowMs = Date.now()): string {
  return formatAiIdempotencyKey(Crypto.randomUUID(), nowMs);
}
