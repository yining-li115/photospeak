import assert from 'node:assert/strict';
import test from 'node:test';
import { AiProviderError, type SpeechSynthesisInput } from './types.js';
import {
  VOLCENGINE_TTS_MAX_AUDIO_BYTES,
  VOLCENGINE_TTS_MAX_TEXT_CHARACTERS,
  VolcengineTtsProvider,
  type VolcengineTtsProviderConfig,
} from './volcengine-tts-provider.js';

const input: SpeechSynthesisInput = {
  text: 'Hello 世界',
  style: 'neutral',
  providerIdempotencyKey: 'application-key-must-not-be-forwarded',
};

function provider(
  fetchImpl: typeof fetch,
  overrides: Partial<VolcengineTtsProviderConfig> = {}
) {
  return new VolcengineTtsProvider({
    apiKey: 'test-api-key',
    voice: 'zh_female_vv_uranus_bigtts',
    fetch: fetchImpl,
    requestId: () => '67ee89ba-7050-4c04-a3d7-ac61a63499b3',
    ...overrides,
  });
}

function chunkedResponse(chunks: Uint8Array[], status = 200): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { status }
  );
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function splitUtf8(text: string, offsets: number[]): Uint8Array[] {
  const encoded = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (const offset of offsets) {
    chunks.push(encoded.slice(start, offset));
    start = offset;
  }
  chunks.push(encoded.slice(start));
  return chunks.filter((chunk) => chunk.byteLength > 0);
}

function assertProviderError(
  kind: AiProviderError['kind'],
  forbiddenText?: string
) {
  return (error: unknown) => {
    assert.ok(error instanceof AiProviderError);
    assert.equal(error.kind, kind);
    if (forbiddenText) assert.doesNotMatch(error.message, new RegExp(forbiddenText));
    return true;
  };
}

test('sends the V3 headers/body and concatenates arbitrarily split NDJSON audio', async () => {
  const firstAudio = Buffer.from([0x49, 0x44, 0x33, 0x04]);
  const secondAudio = Buffer.from([0x00, 0x00, 0x41, 0x42, 0x43]);
  const ndjson =
    jsonLine({ code: 0, message: 'OK', data: firstAudio.toString('base64') }) +
    jsonLine({ code: 0, message: 'OK', data: secondAudio.toString('base64') }) +
    jsonLine({
      code: 20_000_000,
      message: 'ok',
      data: null,
      // Billing uses the submitted Unicode count rather than vendor words.
      usage: { text_words: 999 },
    });
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    // Split inside the first JSON line and place two later lines in one chunk.
    return chunkedResponse(splitUtf8(ndjson, [7, 31, ndjson.length - 20]));
  };

  const adapter = provider(fetchImpl);
  const result = await adapter.synthesizeSpeech(input);

  assert.equal(
    capturedUrl,
    'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
  );
  assert.equal(capturedInit?.method, 'POST');
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers['X-Api-Key'], 'test-api-key');
  assert.equal(headers['X-Api-Resource-Id'], 'seed-tts-2.0');
  assert.equal(
    headers['X-Api-Request-Id'],
    '67ee89ba-7050-4c04-a3d7-ac61a63499b3'
  );
  assert.equal(headers['X-Control-Require-Usage-Tokens-Return'], '*');
  assert.equal(headers['Idempotency-Key'], undefined);
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    req_params: {
      text: input.text,
      speaker: 'zh_female_vv_uranus_bigtts',
      audio_params: { format: 'mp3', sample_rate: 24_000 },
    },
  });
  assert.equal(
    result.base64,
    Buffer.concat([firstAudio, secondAudio]).toString('base64')
  );
  assert.equal(result.transcript, input.text);
  assert.deepEqual(result.usage, { unit: 'characters', inputUnits: 8 });
  assert.equal(adapter.ttsFormat, 'mp3');
  assert.equal(adapter.idempotencyCapability, 'none');
});

test('preserves an unterminated final NDJSON line until EOF', async () => {
  const audio = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
  const response =
    jsonLine({ code: 0, data: audio.toString('base64') }) +
    JSON.stringify({ code: 20_000_000, usage: { text_words: 5 } });
  const fetchImpl: typeof fetch = async () =>
    chunkedResponse(splitUtf8(response, [1, 2, 9, response.length - 1]));

  const result = await provider(fetchImpl).synthesizeSpeech({
    ...input,
    text: 'abcde',
  });
  assert.equal(result.base64, audio.toString('base64'));
  assert.deepEqual(result.usage, { unit: 'characters', inputUnits: 5 });
});

test('maps non-2xx responses without exposing the upstream body', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response('secret upstream credential detail', { status: 401 });
  await assert.rejects(
    provider(fetchImpl).synthesizeSpeech(input),
    assertProviderError('authentication', 'secret')
  );
});

test('maps business errors without exposing the upstream message', async () => {
  const fetchImpl: typeof fetch = async () =>
    chunkedResponse([
      new TextEncoder().encode(
        jsonLine({
          code: 45_000_000,
          message: 'speaker permission denied: internal-secret-detail',
        })
      ),
    ]);
  await assert.rejects(
    provider(fetchImpl).synthesizeSpeech(input),
    assertProviderError('authentication', 'internal-secret-detail')
  );
});

test('rejects a stream that ends without the mandatory finish frame', async () => {
  const fetchImpl: typeof fetch = async () =>
    chunkedResponse([
      new TextEncoder().encode(
        jsonLine({ code: 0, data: Buffer.from('audio').toString('base64') })
      ),
    ]);
  await assert.rejects(
    provider(fetchImpl).synthesizeSpeech(input),
    assertProviderError('bad_response')
  );
});

test('enforces the business text limit before calling the provider', async () => {
  let called = false;
  const fetchImpl: typeof fetch = async () => {
    called = true;
    throw new Error('must not run');
  };
  await assert.rejects(
    provider(fetchImpl).synthesizeSpeech({
      ...input,
      text: 'a'.repeat(VOLCENGINE_TTS_MAX_TEXT_CHARACTERS + 1),
    }),
    assertProviderError('bad_response')
  );
  assert.equal(called, false);
});

test('enforces the decoded 4 MiB audio ceiling incrementally', async () => {
  const first = Buffer.alloc(VOLCENGINE_TTS_MAX_AUDIO_BYTES, 0x41);
  const overflow = Buffer.from([0x42]);
  const fetchImpl: typeof fetch = async () =>
    chunkedResponse([
      new TextEncoder().encode(
        jsonLine({ code: 0, data: first.toString('base64') }) +
          jsonLine({ code: 0, data: overflow.toString('base64') }) +
          jsonLine({ code: 20_000_000 })
      ),
    ]);

  await assert.rejects(
    provider(fetchImpl).synthesizeSpeech(input),
    assertProviderError('bad_response')
  );
});

test('aborts a stalled provider body when the timeout expires', async () => {
  let requestSignal: AbortSignal | undefined;
  let streamCancelled = false;
  const fetchImpl: typeof fetch = async (_url, init) => {
    requestSignal = init?.signal ?? undefined;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              jsonLine({
                code: 0,
                data: Buffer.from('partial').toString('base64'),
              })
            )
          );
        },
        cancel() {
          streamCancelled = true;
        },
      })
    );
  };

  await assert.rejects(
    provider(fetchImpl, { timeoutMs: 20 }).synthesizeSpeech(input),
    assertProviderError('timeout')
  );
  assert.equal(requestSignal?.aborted, true);
  assert.equal(streamCancelled, true);
});
