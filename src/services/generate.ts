import * as Crypto from 'expo-crypto';
import { Directory, File } from 'expo-file-system';
import type { AnalysisResult } from '../api/ai';
import {
  SpeechSynthesisError,
  synthesizeSpeech,
} from '../api/tts';
import {
  aiLogicalKey,
  getOrCreateAiIntent,
  hashAiRequest,
  markAiIntentCompleted,
  markAiIntentPending,
  rotateAiIntentAfterExplicitRestart,
} from '../db/ai-intents';
import { persistGeneratedSession } from '../db/generation';
import { assertSessionIdAvailable, getSession } from '../db/sessions';
import { saveAudioFromBase64 } from '../storage/audio';
import { ownerDirectoryFor } from '../storage/owner-path';
import { assertSafeStorageKey } from '../storage/safety';
import { deleteRecording } from '../storage/recordings';
import type { Card, ChatMessage, Session } from '../types';
import { localDateKey } from '../utils/local-date';
import {
  assertAccountOperationScope,
  captureAccountOperationScope,
  isAccountOperationScopeCurrent,
  type AccountOperationScope,
} from './account-operation';

export type GenerateProgress =
  | { kind: 'sentence'; current: number; total: number }
  | { kind: 'persisting' }
  | { kind: 'done' };

export interface GenerateInput {
  sessionId: string;
  photoUri: string;
  photoThumbnailUri: string;
  recordingUri: string;
  transcript: string;
  analysis: AnalysisResult;
  chatHistory: ChatMessage[];
  /** Set only after the user confirms a newly billable retry. */
  restartExpired?: boolean;
  onProgress?: (p: GenerateProgress) => void;
}

export interface GenerateResult {
  sessionId: string;
  cardCount: number;
  sentenceCount: number;
}

// A double tap or React retry must share one pipeline. Without this guard two
// TTS loops can overwrite the same files before either DB transaction begins.
const inFlight = new Map<string, Promise<GenerateResult>>();

export function generateSession(input: GenerateInput): Promise<GenerateResult> {
  const scope = captureAccountOperationScope();
  const key = `${scope.owner}:${input.sessionId}`;
  const running = inFlight.get(key);
  if (running) return running;

  const task = generateSessionOnce(input, scope).finally(() => {
    if (inFlight.get(key) === task) inFlight.delete(key);
  });
  inFlight.set(key, task);
  return task;
}

async function generateSessionOnce(
  input: GenerateInput,
  scope: AccountOperationScope
): Promise<GenerateResult> {
  const {
    sessionId,
    photoUri,
    photoThumbnailUri,
    transcript,
    analysis,
    chatHistory,
    restartExpired,
    onProgress,
  } = input;

  assertAccountOperationScope(scope);
  await assertSessionIdAvailable(sessionId);
  assertAccountOperationScope(scope);

  // If the DB commit succeeded but the UI missed the completion signal, a
  // retry is a read, not another set of billable TTS requests.
  const existing = await getSession(sessionId, { chatLimit: 0 });
  assertAccountOperationScope(scope);
  if (existing) {
    const result = {
      sessionId,
      cardCount: existing.chunks.length,
      sentenceCount: existing.sentence_audio_uris.length,
    };
    onProgress?.({ kind: 'done' });
    return result;
  }

  const sentenceAudioUris: string[] = [];
  try {
    for (let i = 0; i < analysis.polished_sentences.length; i++) {
      assertAccountOperationScope(scope);
      onProgress?.({
        kind: 'sentence',
        current: i + 1,
        total: analysis.polished_sentences.length,
      });
      const text = analysis.polished_sentences[i];
      const requestBody = { text: text.trim(), style: 'neutral' as const };
      const requestHash = await hashAiRequest(requestBody);
      const logicalKey = aiLogicalKey(
        `tts:${sessionId}:${i}:neutral`,
        requestHash
      );
      let intent = await getOrCreateAiIntent({
        sessionId,
        capability: 'speech_synthesis',
        logicalKey,
        requestHash,
        expectedOwner: scope.owner,
      });
      let attemptFileId = await ttsAttemptFileId(intent.idempotencyKey);
      if (intent.state === 'completed') {
        if (intent.localResultUri) {
          const existingAudio = new File(intent.localResultUri);
          if (existingAudio.exists && existingAudio.size > 0) {
            sentenceAudioUris.push(intent.localResultUri);
            continue;
          }
        }
        await markAiIntentPending({
          capability: 'speech_synthesis',
          logicalKey,
          idempotencyKey: intent.idempotencyKey,
          expectedOwner: scope.owner,
        });
      }
      // File move and SQLite update cannot share one transaction. Because the
      // filename is derived from the stable attempt key, a process killed in
      // that tiny gap can recover the completed file without another API call.
      const recoveredAudio = findTtsCheckpoint(
        scope,
        sessionId,
        i,
        attemptFileId
      );
      if (recoveredAudio) {
        await markAiIntentCompleted({
          capability: 'speech_synthesis',
          logicalKey,
          idempotencyKey: intent.idempotencyKey,
          localResultUri: recoveredAudio,
          expectedOwner: scope.owner,
        });
        sentenceAudioUris.push(recoveredAudio);
        continue;
      }
      // Output format is selected by backend policy (prefer MP3/Opus there;
      // WAV is many times larger for no spoken-playback benefit).
      let result;
      try {
        result = await synthesizeSpeech({
          text,
          idempotencyKey: intent.idempotencyKey,
        });
      } catch (error) {
        if (
          !restartExpired ||
          !(error instanceof SpeechSynthesisError) ||
          !requiresNewTtsAttempt(error.code)
        ) {
          throw error;
        }
        intent = await rotateAiIntentAfterExplicitRestart({
          sessionId,
          capability: 'speech_synthesis',
          logicalKey,
          requestHash,
          previousIdempotencyKey: intent.idempotencyKey,
          expectedOwner: scope.owner,
        });
        attemptFileId = await ttsAttemptFileId(intent.idempotencyKey);
        result = await synthesizeSpeech({
          text,
          idempotencyKey: intent.idempotencyKey,
        });
      }
      assertAccountOperationScope(scope);
      const uri = saveAudioFromBase64(
        result.base64,
        sessionId,
        `sentence-${i}-${attemptFileId}.${result.format === 'ogg_opus' ? 'ogg' : result.format}`,
        scope
      );
      sentenceAudioUris.push(uri);
      await markAiIntentCompleted({
        capability: 'speech_synthesis',
        logicalKey,
        idempotencyKey: intent.idempotencyKey,
        localResultUri: uri,
        expectedOwner: scope.owner,
      });
    }

    onProgress?.({ kind: 'persisting' });
    const now = new Date();
    const nowIso = now.toISOString();
    const session: Session = {
      id: sessionId,
      created_at: nowIso,
      photo_uri: photoUri,
      photo_thumbnail_uri: photoThumbnailUri,
      // The recording has no playback/export consumer after analysis. Keeping
      // 70 seconds of PCM/WAV forever wastes roughly 2 MiB per session.
      recording_uri: '',
      transcript,
      corrected_sentences: analysis.corrected_sentences,
      polished_sentences: analysis.polished_sentences,
      sentence_audio_uris: sentenceAudioUris,
      chunks: analysis.chunks,
      chat_history: chatHistory,
      podcast_generated: true,
      cards_generated: true,
    };
    const cards: Card[] = analysis.chunks.map((chunk) => ({
      id: Crypto.randomUUID(),
      chunk_id: chunk.id,
      chunk: chunk.chunk,
      usage_note: chunk.usage_note,
      examples: chunk.examples,
      photo_thumbnail_uri: photoThumbnailUri,
      source_session_id: sessionId,
      created_at: nowIso,
      next_review_at: nowIso,
      stability: 0,
      difficulty: 0,
      fsrs_elapsed_days: 0,
      fsrs_scheduled_days: 0,
      fsrs_learning_steps: 0,
      fsrs_reps: 0,
      fsrs_lapses: 0,
      fsrs_state: 0,
      fsrs_last_review_at: null,
      review_history: [],
    }));

    assertAccountOperationScope(scope);
    await persistGeneratedSession(
      session,
      cards,
      localDateKey(now),
      scope.owner
    );
    assertAccountOperationScope(scope);
    try {
      if (isAccountOperationScopeCurrent(scope)) {
        deleteRecording(sessionId, scope);
      }
    } catch {
      // The DB deliberately has no recording reference; orphan cleanup retries.
    }
    onProgress?.({ kind: 'done' });

    return {
      sessionId,
      cardCount: cards.length,
      sentenceCount: sentenceAudioUris.length,
    };
  } finally {
    // Successfully written sentence clips are durable checkpoints referenced
    // by owner-scoped intents. Storage maintenance removes abandoned drafts
    // after its grace period; deleting the directory here would defeat resume.
  }
}

function requiresNewTtsAttempt(code?: string): boolean {
  return (
    code === 'IDEMPOTENCY_RESULT_EXPIRED' ||
    code === 'IDEMPOTENCY_KEY_EXPIRED' ||
    code === 'IDEMPOTENCY_RECOVERY_FENCE' ||
    code === 'AI_OPERATION_POLICY_CHANGED' ||
    code === 'AI_OPERATION_UNCERTAIN'
  );
}

async function ttsAttemptFileId(idempotencyKey: string): Promise<string> {
  return (
    await hashAiRequest({ idempotency_key: idempotencyKey })
  ).slice(0, 16);
}

function findTtsCheckpoint(
  scope: AccountOperationScope,
  sessionId: string,
  sentenceIndex: number,
  attemptFileId: string
): string | null {
  assertAccountOperationScope(scope);
  assertSafeStorageKey(sessionId, 'session identifier');
  const directory = new Directory(
    ownerDirectoryFor(scope.owner, 'audio'),
    sessionId
  );
  if (!directory.exists) return null;
  for (const extension of ['mp3', 'ogg', 'wav'] as const) {
    const file = new File(
      directory,
      `sentence-${sentenceIndex}-${attemptFileId}.${extension}`
    );
    if (file.exists && file.size > 0) return file.uri;
  }
  return null;
}
