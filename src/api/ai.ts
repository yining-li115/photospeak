import { File } from 'expo-file-system';
import type {
  ChatMessage,
  Chunk,
  CorrectedSentence,
} from '../types';
import {
  aiLogicalKey,
  getOrCreateAiIntent,
  hashAiRequest,
  markAiIntentCompleted,
  rotateAiIntentAfterExplicitRestart,
} from '../db/ai-intents';
import { requireCurrentOwner } from '../db/owner';
import { ensureDatabaseWriteCapacity } from '../storage/quota';
import {
  assertAuthSessionEpoch,
  BackendError,
  backendRequest,
  getAuthSessionEpoch,
} from './backend';

const MAX_TRANSCRIPT_CHARS = 12_000;
const MAX_QUESTION_CHARS = 1_000;
const MAX_HISTORY_MESSAGES = 12;
const MAX_HISTORY_MESSAGE_CHARS = 4_000;
const MAX_FOLLOW_UP_RESPONSE_CHARS = 8_000;
const MAX_ANALYSIS_PHOTO_BYTES = 2_200_000;
const MAX_POLISHED_SENTENCES = 12;
const MAX_CORRECTIONS = 24;
const MAX_CHUNKS = 5;

export interface AnalysisResult {
  corrected_sentences: CorrectedSentence[];
  polished_sentences: string[];
  chunks: Chunk[];
}

export type AnalyzeMode = 'polish' | 'expand';

export interface AnalyzeInput {
  sessionId: string;
  /** Local URI of the small, normalized analysis image. */
  photoUri: string;
  transcript: string;
  mode?: AnalyzeMode;
  /** Set only after the user accepts a new billable operation. */
  restartExpired?: boolean;
}

export interface FollowUpInput {
  sessionId: string;
  photoUri: string;
  transcript: string;
  analysis: AnalysisResult;
  history: ChatMessage[];
  question: string;
  restartExpired?: boolean;
}

export interface FollowUpResult {
  content: string;
  completedIntent: {
    sessionId: string;
    capability: 'follow_up';
    logicalKey: string;
    idempotencyKey: string;
  };
}

export class AiServiceError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'AiServiceError';
  }
}

interface ProviderChatResponse {
  choices?: {
    message?: {
      content?: string;
    };
  }[];
}

/**
 * Provider-neutral client boundary. The app sends only PhotoSpeak domain data;
 * prompts, model IDs, voices and provider protocols live on the backend. That
 * lets the service change providers or use a fallback without an app
 * release and prevents clients from using our account as a general model proxy.
 */
export async function analyzeSession(input: AnalyzeInput): Promise<AnalysisResult> {
  const authEpoch = getAuthSessionEpoch();
  const owner = requireCurrentOwner();
  const transcript = normalizeRequiredText(
    input.transcript,
    MAX_TRANSCRIPT_CHARS,
    '录音转写为空'
  );
  assertAuthSessionEpoch(authEpoch);
  const photoDataUrl = await readPhotoDataUrl(input.photoUri);
  assertAuthSessionEpoch(authEpoch);

  const body = {
    operation: 'session_analysis' as const,
    photo_data_url: photoDataUrl,
    transcript,
    mode: input.mode ?? 'polish',
  };
  const requestHash = await hashAiRequest(body);
  const logicalKey = aiLogicalKey(
    `analysis:${input.sessionId}:${body.mode}`,
    requestHash
  );
  let intent = await getOrCreateAiIntent({
    sessionId: input.sessionId,
    capability: 'session_analysis',
    logicalKey,
    requestHash,
    expectedOwner: owner,
  });
  if (input.restartExpired) {
    intent = await rotateAiIntentAfterExplicitRestart({
      sessionId: input.sessionId,
      capability: 'session_analysis',
      logicalKey,
      requestHash,
      previousIdempotencyKey: intent.idempotencyKey,
      expectedOwner: owner,
    });
  }
  assertAuthSessionEpoch(authEpoch);
  const response = await requestAi(
    body,
    90_000,
    authEpoch,
    intent.idempotencyKey
  );
  const result = parseAnalysisJson(extractContent(response));
  await markAiIntentCompleted({
    capability: 'session_analysis',
    logicalKey,
    idempotencyKey: intent.idempotencyKey,
    expectedOwner: owner,
  });
  assertAuthSessionEpoch(authEpoch);
  return result;
}

export async function followUpChat(input: FollowUpInput): Promise<FollowUpResult> {
  const authEpoch = getAuthSessionEpoch();
  const owner = requireCurrentOwner();
  const question = normalizeRequiredText(
    input.question,
    MAX_QUESTION_CHARS,
    '请输入问题'
  );
  const transcript = normalizeRequiredText(
    input.transcript,
    MAX_TRANSCRIPT_CHARS,
    '原始转写为空'
  );
  // Revalidate persisted data before it crosses the network. Old or partially
  // migrated rows should fail safely instead of creating an oversized prompt.
  assertAnalysisResult(input.analysis);

  const history = input.history
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, MAX_HISTORY_MESSAGE_CHARS),
    }));

  assertAuthSessionEpoch(authEpoch);
  const photoDataUrl = await readPhotoDataUrl(input.photoUri);
  assertAuthSessionEpoch(authEpoch);

  const body = {
    operation: 'follow_up' as const,
    photo_data_url: photoDataUrl,
    transcript,
    analysis: input.analysis,
    history,
    question,
  };
  const requestHash = await hashAiRequest(body);
  const logicalKey = aiLogicalKey(
    `followup:${input.sessionId}`,
    requestHash
  );
  let intent = await getOrCreateAiIntent({
    sessionId: input.sessionId,
    capability: 'follow_up',
    logicalKey,
    requestHash,
    expectedOwner: owner,
  });
  if (input.restartExpired) {
    intent = await rotateAiIntentAfterExplicitRestart({
      sessionId: input.sessionId,
      capability: 'follow_up',
      logicalKey,
      requestHash,
      previousIdempotencyKey: intent.idempotencyKey,
      expectedOwner: owner,
    });
  }
  // Reserve enough local DB/WAL headroom for the question and the largest
  // accepted answer before the provider can charge for this operation.
  const writeTimestamp = new Date().toISOString();
  ensureDatabaseWriteCapacity([
    input.sessionId,
    { role: 'user', content: question, timestamp: writeTimestamp },
    {
      role: 'assistant',
      content: '\u{10ffff}'.repeat(MAX_FOLLOW_UP_RESPONSE_CHARS),
      timestamp: writeTimestamp,
    },
  ]);
  assertAuthSessionEpoch(authEpoch);
  const response = await requestAi(
    body,
    60_000,
    authEpoch,
    intent.idempotencyKey
  );

  const content = extractContent(response).trim();
  if (!content) {
    throw new AiServiceError('AI 返回了空回复', 502, 'AI_EMPTY_RESPONSE');
  }
  await markAiIntentCompleted({
    capability: 'follow_up',
    logicalKey,
    idempotencyKey: intent.idempotencyKey,
    expectedOwner: owner,
  });
  assertAuthSessionEpoch(authEpoch);
  return {
    content,
    completedIntent: {
      sessionId: input.sessionId,
      capability: 'follow_up',
      logicalKey,
      idempotencyKey: intent.idempotencyKey,
    },
  };
}

async function requestAi(
  body: Record<string, unknown>,
  timeoutMs: number,
  expectedAuthEpoch: number,
  idempotencyKey: string
): Promise<ProviderChatResponse> {
  try {
    return await backendRequest<ProviderChatResponse>(
      'POST',
      '/api/analyze',
      body,
      { timeoutMs, expectedAuthEpoch, idempotencyKey }
    );
  } catch (error) {
    if (error instanceof BackendError) {
      throw new AiServiceError(error.message, error.status, error.code);
    }
    throw new AiServiceError(
      error instanceof Error ? error.message : 'AI 服务暂时不可用'
    );
  }
}

async function readPhotoDataUrl(uri: string): Promise<string> {
  if (!uri) throw new AiServiceError('照片不存在', undefined, 'PHOTO_MISSING');
  try {
    const file = new File(uri);
    if (!file.exists || file.size <= 0) throw new Error('empty file');
    if (file.size > MAX_ANALYSIS_PHOTO_BYTES) {
      throw new AiServiceError(
        '照片过大，请重新选择后再试',
        undefined,
        'PHOTO_TOO_LARGE'
      );
    }
    const base64 = await file.base64();
    if (!base64) throw new Error('empty file');
    return `data:image/jpeg;base64,${base64}`;
  } catch (error) {
    if (error instanceof AiServiceError) throw error;
    throw new AiServiceError(
      '无法读取照片，请重新选择',
      undefined,
      'PHOTO_READ_FAILED'
    );
  }
}

function extractContent(response: ProviderChatResponse): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    // Do not include provider payloads: they may contain the learner's text and
    // would otherwise be forwarded to crash reports.
    throw new AiServiceError(
      'AI 返回格式错误，请重试',
      502,
      'AI_INVALID_RESPONSE'
    );
  }
  return content;
}

export function parseAnalysisJson(raw: string): AnalysisResult {
  const stripped = stripCodeFence(raw.trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new AiServiceError(
      'AI 分析结果无法解析，请重试',
      502,
      'AI_INVALID_JSON'
    );
  }
  assertAnalysisResult(parsed);
  return parsed;
}

function assertAnalysisResult(value: unknown): asserts value is AnalysisResult {
  if (!isRecord(value)) invalidAnalysis();

  const corrected = value.corrected_sentences;
  const polished = value.polished_sentences;
  const chunks = value.chunks;

  if (
    !Array.isArray(corrected) ||
    corrected.length > MAX_CORRECTIONS ||
    !corrected.every(isCorrectedSentence)
  ) {
    invalidAnalysis();
  }
  if (
    !Array.isArray(polished) ||
    polished.length < 1 ||
    polished.length > MAX_POLISHED_SENTENCES ||
    !polished.every((sentence) => isBoundedString(sentence, 1, 800))
  ) {
    invalidAnalysis();
  }
  if (
    !Array.isArray(chunks) ||
    chunks.length > MAX_CHUNKS ||
    !chunks.every(isChunk)
  ) {
    invalidAnalysis();
  }

  const ids = new Set(chunks.map((chunk) => chunk.id));
  if (ids.size !== chunks.length) invalidAnalysis();
}

function isCorrectedSentence(value: unknown): value is CorrectedSentence {
  if (!isRecord(value)) return false;
  return (
    isBoundedString(value.original, 1, 1_000) &&
    isBoundedString(value.corrected, 1, 1_000) &&
    ['grammar', 'vocabulary', 'preposition', 'article', 'other'].includes(
      String(value.error_type)
    ) &&
    isBoundedString(value.explanation, 0, 1_500) &&
    typeof value.is_common_for_chinese_speakers === 'boolean'
  );
}

function isChunk(value: unknown): value is Chunk {
  if (!isRecord(value)) return false;
  if (
    !isBoundedString(value.id, 1, 100) ||
    !isBoundedString(value.chunk, 2, 200) ||
    !isBoundedString(value.usage_note, 1, 1_500) ||
    !Array.isArray(value.examples) ||
    value.examples.length !== 2
  ) {
    return false;
  }
  return value.examples.every(
    (example) => isRecord(example) && isBoundedString(example.text, 1, 800)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(
  value: unknown,
  minLength: number,
  maxLength: number
): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length >= minLength &&
    value.length <= maxLength
  );
}

function normalizeRequiredText(
  value: string,
  maxLength: number,
  emptyMessage: string
): string {
  const normalized = value.trim();
  if (!normalized) throw new AiServiceError(emptyMessage);
  if (normalized.length > maxLength) {
    throw new AiServiceError(`内容过长，最多允许 ${maxLength} 个字符`);
  }
  return normalized;
}

function invalidAnalysis(): never {
  throw new AiServiceError(
    'AI 分析结果结构不完整，请重试',
    502,
    'AI_SCHEMA_MISMATCH'
  );
}

function stripCodeFence(value: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value);
  return match ? match[1] : value;
}
