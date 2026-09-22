#!/usr/bin/env node

import { deflateSync } from 'node:zlib';

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

  // A generated opaque PNG keeps the probe deterministic and cheap while
  // staying above provider minimum-image-size checks.
  const chatResult = await chat.completeText({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: solidPngDataUrl(128, 128),
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

function solidPngDataUrl(width, height) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 4;
      raw[pixel] = 255;
      raw[pixel + 1] = 64;
      raw[pixel + 2] = 64;
      raw[pixel + 3] = 255;
    }
  }

  const signature = Buffer.from('89504e470d0a1a0a', 'hex');
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const png = Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, checksum]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
