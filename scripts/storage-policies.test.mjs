import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import {
  HARD_APP_STORAGE_LIMIT_BYTES,
  MIN_DEVICE_FREE_STORAGE_BYTES,
  appWriteCapacityFailure,
  estimateDatabaseGrowthBytes,
} from '../src/storage/capacity-policy.ts';
import {
  isManagedMediaRelativePath,
} from '../src/storage/safety.ts';
import {
  MAX_GENERATED_AUDIO_BYTES,
  generatedAudioByteLength,
} from '../src/storage/generated-audio-policy.ts';

test('app writes preserve both the total app cap and device free-space floor', () => {
  assert.equal(
    appWriteCapacityFailure({
      appStorageBytes: HARD_APP_STORAGE_LIMIT_BYTES - 4,
      availableBytes: MIN_DEVICE_FREE_STORAGE_BYTES + 4,
      incomingBytes: 4,
    }),
    null
  );
  assert.equal(
    appWriteCapacityFailure({
      appStorageBytes: HARD_APP_STORAGE_LIMIT_BYTES - 4,
      availableBytes: MIN_DEVICE_FREE_STORAGE_BYTES + 5,
      incomingBytes: 5,
    }),
    'app_limit'
  );
  assert.equal(
    appWriteCapacityFailure({
      appStorageBytes: 0,
      availableBytes: MIN_DEVICE_FREE_STORAGE_BYTES + 3,
      incomingBytes: 4,
    }),
    'device_free_limit'
  );
});

test('abandoned-intent cleanup only accepts app-owned canonical media paths', () => {
  assert.equal(
    isManagedMediaRelativePath('users/owner/audio/sentence-0-key.mp3'),
    true
  );
  assert.equal(isManagedMediaRelativePath('audio/session/sentence.wav'), true);
  assert.equal(isManagedMediaRelativePath('../outside.wav'), false);
  assert.equal(isManagedMediaRelativePath('users/owner/../../outside.wav'), false);
  assert.equal(isManagedMediaRelativePath('file:///private/outside.wav'), false);
});

test('database growth reservation handles SQLite overhead and UTF-8 payloads', () => {
  assert.equal(estimateDatabaseGrowthBytes([]), 64 * 1024);
  assert.equal(estimateDatabaseGrowthBytes(['small']), 64 * 1024);
  assert.equal(
    estimateDatabaseGrowthBytes(['🙂'.repeat(20_000)]),
    240_000
  );
});

test('generated audio uses exact canonical-base64 byte accounting', () => {
  assert.equal(generatedAudioByteLength(Buffer.from('abc').toString('base64')), 3);
  assert.equal(generatedAudioByteLength(Buffer.from('ab').toString('base64')), 2);
  assert.throws(() => generatedAudioByteLength('not base64'));
  assert.throws(() =>
    generatedAudioByteLength(
      Buffer.alloc(MAX_GENERATED_AUDIO_BYTES + 1).toString('base64')
    )
  );
});
