import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';
import test from 'node:test';
import {
  encodeVolcengineAudio,
  encodeVolcengineConfig,
  extractVolcengineResult,
  parseVolcengineServerFrame,
  type VolcengineAsrRequest,
} from './volcengine-protocol.js';

const request: VolcengineAsrRequest = {
  user: { uid: 'user-1' },
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
};

test('encodes the gzip JSON full-client request', () => {
  const frame = encodeVolcengineConfig(request);
  assert.deepEqual([...frame.subarray(0, 4)], [0x11, 0x10, 0x11, 0x00]);
  const size = frame.readUInt32BE(4);
  assert.equal(size, frame.byteLength - 8);
  assert.deepEqual(
    JSON.parse(gunzipSync(frame.subarray(8)).toString('utf8')),
    request
  );
});

test('encodes ordinary and terminal PCM packets with the correct flags', () => {
  const pcm = Buffer.from([1, 2, 3, 4]);
  for (const [isLast, expectedHeader] of [
    [false, 0x20],
    [true, 0x22],
  ] as const) {
    const frame = encodeVolcengineAudio(pcm, isLast);
    assert.equal(frame[1], expectedHeader);
    assert.equal(frame[2], 0x01);
    assert.deepEqual(gunzipSync(frame.subarray(8)), pcm);
  }
});

test('parses full, sequenced, terminal provider responses', () => {
  const payload = {
    result: {
      text: 'A complete sentence.',
      utterances: [{ definite: true }],
    },
  };
  const parsed = parseVolcengineServerFrame(
    responseFrame(payload, { flags: 0x3, sequence: -7 })
  );
  assert.deepEqual(parsed, {
    type: 'response',
    isLast: true,
    sequence: -7,
    payload,
  });
  assert.deepEqual(extractVolcengineResult(payload), {
    text: 'A complete sentence.',
    final: true,
  });
});

test('parses responses without a sequence field', () => {
  const payload = { result: { text: 'partial', utterances: [] } };
  assert.deepEqual(parseVolcengineServerFrame(responseFrame(payload)), {
    type: 'response',
    isLast: false,
    sequence: undefined,
    payload,
  });
  assert.deepEqual(extractVolcengineResult(payload), {
    text: 'partial',
    final: false,
  });
});

test('parses provider error frames without exposing binary data', () => {
  const body = Buffer.from(JSON.stringify({ message: 'quota exceeded' }));
  const header = Buffer.from([0x11, 0xf0, 0x00, 0x00]);
  const metadata = Buffer.alloc(8);
  metadata.writeUInt32BE(45_000_003, 0);
  metadata.writeUInt32BE(body.byteLength, 4);
  assert.deepEqual(
    parseVolcengineServerFrame(Buffer.concat([header, metadata, body])),
    { type: 'error', code: 45_000_003, message: 'quota exceeded' }
  );
});

test('rejects malformed and oversized provider frames', () => {
  const malformed = responseFrame({ result: { text: 'ok' } });
  malformed.writeUInt32BE(1, 4);
  assert.throws(
    () => parseVolcengineServerFrame(malformed),
    /payload length does not match frame/
  );

  const oversized = Buffer.alloc(8);
  oversized.set([0x11, 0x90, 0x10, 0x00], 0);
  oversized.writeUInt32BE(512 * 1024 + 1, 4);
  assert.throws(
    () => parseVolcengineServerFrame(oversized),
    /payload is too large/
  );
});

function responseFrame(
  payload: unknown,
  options: { flags?: number; sequence?: number } = {}
): Buffer {
  const flags = options.flags ?? 0;
  const body = gzipSync(Buffer.from(JSON.stringify(payload)));
  const header = Buffer.from([0x11, 0x90 | flags, 0x11, 0x00]);
  const sequence =
    (flags & 0x1) !== 0
      ? (() => {
          const value = Buffer.alloc(4);
          value.writeInt32BE(options.sequence ?? 0);
          return value;
        })()
      : Buffer.alloc(0);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.byteLength);
  return Buffer.concat([header, sequence, size, body]);
}
