import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeRequestSchema,
  parseAnalysisContent,
  ttsRequestSchema,
} from './contracts.js';

const jpegBytes = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(32),
]);
const photo = `data:image/jpeg;base64,${jpegBytes.toString('base64')}`;

test('analysis API accepts the narrow session-analysis DTO', () => {
  const value = analyzeRequestSchema.parse({
    operation: 'session_analysis',
    client_session_id: '018f47ac-2f17-7bb5-8f52-92f0b92d7271',
    photo_data_url: photo,
    transcript: 'There is a dog in the park.',
    mode: 'polish',
  });
  assert.equal(value.operation, 'session_analysis');
});

test('analysis API rejects the former generic model/messages proxy body', () => {
  const result = analyzeRequestSchema.safeParse({
    model: 'some-model',
    messages: [{ role: 'user', content: 'run an unrelated request' }],
  });
  assert.equal(result.success, false);
});

test('analysis API rejects a mismatched or non-image data URL before billing', () => {
  const pngBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32),
  ]);
  const common = {
    operation: 'session_analysis',
    client_session_id: '018f47ac-2f17-7bb5-8f52-92f0b92d7271',
    transcript: 'There is a dog in the park.',
    mode: 'polish',
  } as const;

  assert.equal(
    analyzeRequestSchema.safeParse({
      ...common,
      photo_data_url: `data:image/jpeg;base64,${pngBytes.toString('base64')}`,
    }).success,
    false
  );
  assert.equal(
    analyzeRequestSchema.safeParse({
      ...common,
      photo_data_url: `data:image/jpeg;base64,${Buffer.from('not an image').toString('base64')}`,
    }).success,
    false
  );
});

test('model analysis output is validated deeply', () => {
  assert.throws(() =>
    parseAnalysisContent(
      JSON.stringify({
        corrected_sentences: [],
        polished_sentences: ['Natural sentence.'],
        chunks: [{ id: 'x', chunk: 'in fact', examples: [] }],
      })
    )
  );
});

test('TTS clients cannot choose a provider model, voice, or format', () => {
  const result = ttsRequestSchema.safeParse({
    text: 'Hello.',
    model: 'expensive-model',
    voice: 'arbitrary-voice',
  });
  assert.equal(result.success, false);
});
