import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { gunzipSync, gzipSync } from 'node:zlib';
import test from 'node:test';
import WebSocket, { type ClientOptions, type RawData } from 'ws';
import type { TranscriptionProviderEvent } from './provider.js';
import { VolcengineAsrProvider } from './volcengine-provider.js';

test('provider authenticates, batches 200ms PCM, and maps final text', async () => {
  const events: TranscriptionProviderEvent[] = [];
  const socket = new FakeWebSocket();
  let socketOptions: ClientOptions | undefined;
  let resolveCompleted!: () => void;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const provider = new VolcengineAsrProvider({
    apiKey: 'test-speech-key',
    upstreamUrl: 'wss://openspeech.bytedance.com/test',
    resourceId: 'volc.seedasr.sauc.duration',
    enableNonstream: true,
    vadSilenceMs: 800,
    packetMs: 200,
    webSocketFactory: (_url, options) => {
      socketOptions = options;
      queueMicrotask(() => socket.open());
      return socket as unknown as WebSocket;
    },
  });
  const session = provider.createSession({
    requestId: 'request-123',
    userId: 'user-456',
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'ready') {
        session.sendAudio(Buffer.alloc(3_200, 1));
        session.sendAudio(Buffer.alloc(3_200, 2));
        session.finish();
      }
      if (event.type === 'completed') resolveCompleted();
    },
  });

  await waitFor(() => socket.sent.length === 1);
  socket.providerMessage(serverResponse({}));
  await waitFor(() => socket.sent.length === 3);
  socket.providerMessage(
    serverResponse({
      result: {
        text: 'The final transcript.',
        utterances: [{ definite: true }],
      },
    })
  );
  socket.providerMessage(
    serverResponse(
      {
        result: {
          text: 'The final transcript.',
          utterances: [{ definite: true }],
        },
      },
      true
    )
  );
  await withTimeout(completed, 2_000);

  const seenHeaders = socketOptions?.headers as
    | Record<string, string>
    | undefined;
  assert(seenHeaders);
  assert.equal(seenHeaders['X-Api-Key'], 'test-speech-key');
  assert.equal(
    seenHeaders['X-Api-Resource-Id'],
    'volc.seedasr.sauc.duration'
  );
  assert.equal(seenHeaders['X-Api-Request-Id'], 'request-123');
  assert.equal(seenHeaders['X-Api-Sequence'], '-1');
  assert.equal(typeof seenHeaders['X-Api-Connect-Id'], 'string');

  assert.equal(socket.sent.length, 3);
  assert.equal(socket.sent[0]![1], 0x10);
  const config = JSON.parse(
    decodeClientPayload(socket.sent[0]!).toString('utf8')
  );
  assert.equal(config.user.uid, 'user-456');
  assert.equal(config.request.enable_nonstream, true);
  assert.equal(socket.sent[1]![1], 0x20);
  assert.equal(decodeClientPayload(socket.sent[1]!).byteLength, 6_400);
  assert.equal(socket.sent[2]![1], 0x22);
  assert.equal(decodeClientPayload(socket.sent[2]!).byteLength, 0);
  assert.deepEqual(events, [
    { type: 'ready' },
    {
      type: 'transcript',
      text: 'The final transcript.',
      final: true,
    },
    { type: 'completed', text: 'The final transcript.' },
  ]);
});

function decodeClientPayload(frame: Buffer): Buffer {
  const payloadSize = frame.readUInt32BE(4);
  assert.equal(payloadSize, frame.byteLength - 8);
  return gunzipSync(frame.subarray(8));
}

function serverResponse(payload: unknown, isLast = false): Buffer {
  const body = gzipSync(Buffer.from(JSON.stringify(payload)));
  const header = Buffer.from([0x11, 0x90 | (isLast ? 0x2 : 0), 0x11, 0x00]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.byteLength);
  return Buffer.concat([header, size, body]);
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(new Uint8Array(data));
}

class FakeWebSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  readonly sent: Buffer[] = [];

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }

  providerMessage(frame: Buffer): void {
    this.emit('message', frame, true);
  }

  send(data: RawData): void {
    this.sent.push(rawDataToBuffer(data));
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }

  terminate(): void {
    this.readyState = WebSocket.CLOSED;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition did not become true');
}

function withTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('provider test timed out')),
      timeoutMs
    );
    operation.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
