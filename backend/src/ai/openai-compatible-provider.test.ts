import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAiCompatibleTextProvider } from './openai-compatible-provider.js';
import {
  MAX_TTS_AUDIO_BYTES,
  validateEncodedAudio,
} from './speech-audio.js';
import { AiProviderError } from './types.js';

function provider() {
  return new OpenAiCompatibleTextProvider({
    name: 'test-provider',
    baseUrl: 'https://provider.invalid/v1',
    apiKey: 'not-a-real-key',
    authStyle: 'bearer',
    model: 'test-chat',
  });
}

test('provider 401 is classified as provider authentication, not user auth', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('{"error":"bad upstream key"}', { status: 401 });
  try {
    await assert.rejects(
      provider().completeText({
        messages: [{ role: 'user', content: 'hello' }],
        maxOutputTokens: 10,
        temperature: 0,
        providerIdempotencyKey: 'test-operation-key',
      }),
      (error) =>
        error instanceof AiProviderError && error.kind === 'authentication'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('speech payload validation accepts only the declared audio container', () => {
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36, 4);
  wav.write('WAVE', 8, 'ascii');
  assert.equal(validateEncodedAudio(wav.toString('base64'), 'wav'), wav.length);

  const mp3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
  assert.equal(validateEncodedAudio(mp3.toString('base64'), 'mp3'), mp3.length);

  const opus = Buffer.alloc(64);
  opus.write('OggS', 0, 'ascii');
  opus.write('OpusHead', 28, 'ascii');
  assert.equal(
    validateEncodedAudio(opus.toString('base64'), 'ogg_opus'),
    opus.length
  );

  assert.throws(() => validateEncodedAudio(wav.toString('base64'), 'mp3'));
  assert.throws(() => validateEncodedAudio('not base64', 'wav'));
});

test('speech payload validation enforces the decoded-byte ceiling', () => {
  const oversized = Buffer.alloc(MAX_TTS_AUDIO_BYTES + 1);
  oversized.write('RIFF', 0, 'ascii');
  oversized.write('WAVE', 8, 'ascii');
  assert.throws(() => validateEncodedAudio(oversized.toString('base64'), 'wav'));
});
