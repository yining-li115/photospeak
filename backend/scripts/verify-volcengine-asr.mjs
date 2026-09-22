/**
 * Opt-in live handshake check for the exact Volcengine ASR configuration used
 * by PhotoSpeak. This can consume provider quota, so tests never run it.
 * Execute manually from backend/ only after loading backend/.env.
 * Secrets and response bodies are never printed.
 */
import 'dotenv/config';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { WebSocket } from 'ws';

const apiKey = process.env.AI_ASR_API_KEY;
const resourceId =
  process.env.AI_ASR_RESOURCE_ID || 'volc.seedasr.sauc.duration';
const upstreamUrl =
  process.env.AI_ASR_WS_URL ||
  'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';

if (!apiKey) {
  console.error('AI_ASR_API_KEY is missing from backend/.env');
  process.exit(2);
}

const parsedUrl = new URL(upstreamUrl);
if (
  parsedUrl.protocol !== 'wss:' ||
  parsedUrl.hostname !== 'openspeech.bytedance.com'
) {
  console.error('AI_ASR_WS_URL must use wss://openspeech.bytedance.com');
  process.exit(2);
}

const requestId = randomUUID();
const socket = new WebSocket(upstreamUrl, {
  headers: {
    'X-Api-Key': apiKey,
    'X-Api-Resource-Id': resourceId,
    'X-Api-Request-Id': requestId,
    'X-Api-Sequence': '-1',
    'X-Api-Connect-Id': randomUUID(),
  },
  perMessageDeflate: false,
});

const timeout = setTimeout(() => {
  console.error('[verify] timed out waiting for the ASR handshake');
  socket.terminate();
  process.exit(1);
}, 15_000);
let accepted = false;

socket.on('open', () => {
  console.log('[verify] WebSocket open; sending bounded ASR configuration');
  socket.send(
    frame(
      0x1,
      0,
      0x1,
      Buffer.from(
        JSON.stringify({
          user: { uid: 'photospeak-live-check' },
          audio: {
            format: 'pcm',
            codec: 'raw',
            rate: 16_000,
            bits: 16,
            channel: 1,
          },
          request: {
            model_name: 'bigmodel',
            enable_nonstream: true,
            enable_itn: true,
            enable_punc: true,
            enable_ddc: false,
            show_utterances: true,
            result_type: 'full',
            end_window_size: 800,
          },
        })
      )
    )
  );
});

socket.on('message', (_data, isBinary) => {
  if (!isBinary || accepted) return;
  accepted = true;
  clearTimeout(timeout);
  console.log('[verify] ASR handshake accepted; closing without user audio');
  socket.send(frame(0x2, 0x2, 0x0, Buffer.alloc(0)));
  setTimeout(() => socket.close(1000), 200);
  setTimeout(() => process.exit(0), 400);
});

socket.on('unexpected-response', (_request, response) => {
  clearTimeout(timeout);
  console.error(`[verify] handshake rejected with HTTP ${response.statusCode}`);
  process.exit(1);
});

socket.on('error', () => {
  clearTimeout(timeout);
  console.error('[verify] WebSocket error');
  process.exit(1);
});

function frame(messageType, flags, serialization, payload) {
  const compressed = gzipSync(payload);
  const header = Buffer.from([
    0x11,
    (messageType << 4) | flags,
    (serialization << 4) | 0x1,
    0,
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(compressed.byteLength);
  return Buffer.concat([header, size, compressed]);
}
