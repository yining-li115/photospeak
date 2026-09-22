#!/usr/bin/env node

/**
 * Bounded real-provider probe for Ark multimodal chat and Volcengine TTS.
 *
 * Build the backend first, then run this only after loading backend/.env into
 * the process environment. The probe never prints credentials, model output,
 * image contents, or generated audio, and it does not persist provider data.
 */

const REQUIRED = [
  'AI_CHAT_API_KEY',
  'AI_CHAT_BASE_URL',
  'AI_CHAT_MODEL',
  'AI_TTS_API_KEY',
  'AI_TTS_VOICE',
];

for (const name of REQUIRED) {
  if (!process.env[name]?.trim()) {
    console.error(`[verify] missing required environment variable: ${name}`);
    process.exit(2);
  }
}

const timeout = positiveInt(process.env.AI_CHAT_TIMEOUT_MS, 60_000);
const ttsTimeout = positiveInt(process.env.AI_TTS_TIMEOUT_MS, 60_000);

try {
  const [{ OpenAiCompatibleTextProvider }, { VolcengineTtsProvider }] =
    await Promise.all([
      import('../dist/ai/openai-compatible-provider.js'),
      import('../dist/ai/volcengine-tts-provider.js'),
    ]);

  const chat = new OpenAiCompatibleTextProvider({
    name: process.env.AI_CHAT_PROVIDER?.trim() || 'volcengine-ark',
    baseUrl: process.env.AI_CHAT_BASE_URL.trim(),
    apiKey: process.env.AI_CHAT_API_KEY.trim(),
    authStyle:
      process.env.AI_CHAT_AUTH_STYLE?.trim() === 'api-key'
        ? 'api-key'
        : 'bearer',
    model: process.env.AI_CHAT_MODEL.trim(),
    maxTokensField:
      process.env.AI_CHAT_MAX_TOKENS_FIELD?.trim() ===
      'max_completion_tokens'
        ? 'max_completion_tokens'
        : 'max_tokens',
    timeoutMs: timeout,
  });

  // A tiny opaque PNG keeps the probe cheap while proving the configured Ark
  // model accepts PhotoSpeak's image_url message shape.
  const chatResult = await chat.completeText({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zf88AAAAASUVORK5CYII=',
            },
          },
          {
            type: 'text',
            text: 'Reply with one short English word describing the image.',
          },
        ],
      },
    ],
    maxOutputTokens: 16,
    temperature: 0,
    providerIdempotencyKey: 'manual-connectivity-probe',
  });

  if (!chatResult.content.trim()) {
    throw new Error('Ark returned an empty multimodal response');
  }
  console.log('[verify] Ark multimodal chat accepted the bounded probe');

  const tts = new VolcengineTtsProvider({
    apiKey: process.env.AI_TTS_API_KEY.trim(),
    voice: process.env.AI_TTS_VOICE.trim(),
    resourceId: process.env.AI_TTS_RESOURCE_ID?.trim() || 'seed-tts-2.0',
    endpoint:
      process.env.AI_TTS_ENDPOINT?.trim() ||
      'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
    timeoutMs: ttsTimeout,
  });
  const speechResult = await tts.synthesizeSpeech({
    text: 'PhotoSpeak connectivity check.',
    style: 'neutral',
    providerIdempotencyKey: 'manual-connectivity-probe',
  });
  const audioBytes = Buffer.from(speechResult.base64, 'base64').byteLength;
  if (audioBytes <= 0) throw new Error('TTS returned empty audio');
  console.log(`[verify] Volcengine TTS returned ${audioBytes} audio bytes`);
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown failure';
  console.error(`[verify] real-provider probe failed: ${message}`);
  process.exit(1);
}

function positiveInt(value, fallback) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    console.error('[verify] timeout must be a positive integer');
    process.exit(2);
  }
  return parsed;
}
