import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import {
  analysisImageDataUrl,
  detectAnalysisImageMime,
} from '../src/api/image-data-url.ts';

function encoded(bytes) {
  return Buffer.from(bytes).toString('base64');
}

test('detects supported image formats from bytes rather than filenames', () => {
  const jpeg = encoded([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  const png = encoded([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const webp = encoded([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
  ]);

  assert.equal(detectAnalysisImageMime(jpeg), 'image/jpeg');
  assert.equal(detectAnalysisImageMime(png), 'image/png');
  assert.equal(detectAnalysisImageMime(webp), 'image/webp');
  assert.equal(analysisImageDataUrl(png), `data:image/png;base64,${png}`);
});

test('rejects unsupported, corrupt, and non-image payloads', () => {
  assert.equal(detectAnalysisImageMime(''), null);
  assert.equal(detectAnalysisImageMime('not base64'), null);
  assert.equal(
    detectAnalysisImageMime(encoded([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70])),
    null
  );
});
