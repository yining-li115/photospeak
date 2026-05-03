import * as Crypto from 'expo-crypto';
import type { AnalysisResult } from '../api/mimo';
import { synthesizeSpeech } from '../api/mimo-tts';
import { createCard } from '../db/cards';
import { createSession } from '../db/sessions';
import { incrementSessionCount } from '../db/stats';
import { saveAudioFromBase64 } from '../storage/audio';
import type { Card, ChatMessage } from '../types';

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
  onProgress?: (p: GenerateProgress) => void;
}

export interface GenerateResult {
  sessionId: string;
  cardCount: number;
  sentenceCount: number;
}

export async function generateSession(
  input: GenerateInput
): Promise<GenerateResult> {
  const {
    sessionId,
    photoUri,
    photoThumbnailUri,
    recordingUri,
    transcript,
    analysis,
    chatHistory,
    onProgress,
  } = input;

  const sentenceAudioUris: string[] = [];
  for (let i = 0; i < analysis.polished_sentences.length; i++) {
    onProgress?.({
      kind: 'sentence',
      current: i + 1,
      total: analysis.polished_sentences.length,
    });
    const result = await synthesizeSpeech({
      text: analysis.polished_sentences[i],
    });
    const uri = saveAudioFromBase64(
      result.base64,
      sessionId,
      `sentence-${i}.${result.format}`
    );
    sentenceAudioUris.push(uri);
  }

  // Cards UI no longer plays per-example audio, so we keep chunks as
  // they came back from MiMo (text-only examples). Saves a bunch of
  // TTS calls + wav file writes.
  const enrichedChunks = analysis.chunks;

  onProgress?.({ kind: 'persisting' });

  const now = new Date().toISOString();
  await createSession({
    id: sessionId,
    created_at: now,
    photo_uri: photoUri,
    photo_thumbnail_uri: photoThumbnailUri,
    recording_uri: recordingUri,
    transcript,
    corrected_sentences: analysis.corrected_sentences,
    polished_sentences: analysis.polished_sentences,
    sentence_audio_uris: sentenceAudioUris,
    chunks: enrichedChunks,
    chat_history: chatHistory,
    podcast_generated: true,
    cards_generated: true,
  });

  for (const chunk of enrichedChunks) {
    const card: Card = {
      id: Crypto.randomUUID(),
      chunk_id: chunk.id,
      chunk: chunk.chunk,
      usage_note: chunk.usage_note,
      examples: chunk.examples,
      photo_thumbnail_uri: photoThumbnailUri,
      source_session_id: sessionId,
      created_at: now,
      next_review_at: now,
      stability: 0,
      difficulty: 0,
      review_history: [],
    };
    await createCard(card);
  }

  await incrementSessionCount(now.slice(0, 10));

  onProgress?.({ kind: 'done' });

  return {
    sessionId,
    cardCount: enrichedChunks.length,
    sentenceCount: sentenceAudioUris.length,
  };
}
