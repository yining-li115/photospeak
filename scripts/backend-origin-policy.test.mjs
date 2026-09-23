import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRODUCTION_API_BASE,
  resolveBackendBaseUrl,
} from '../src/api/backend-origin.ts';

test('production always uses the pinned HTTPS API origin', () => {
  assert.equal(PRODUCTION_API_BASE, 'https://api.dailyphotospeak.cn');
  assert.equal(
    resolveBackendBaseUrl({
      isDev: false,
      developmentOverride: 'http://47.102.40.169:3000/',
    }),
    PRODUCTION_API_BASE
  );
  assert.equal(
    resolveBackendBaseUrl({
      isDev: false,
      developmentOverride: 'https://example.invalid',
    }),
    PRODUCTION_API_BASE
  );
});

test('development may opt into a local backend and trims trailing slashes', () => {
  assert.equal(
    resolveBackendBaseUrl({
      isDev: true,
      developmentOverride: ' http://127.0.0.1:3000/// ',
    }),
    'http://127.0.0.1:3000'
  );
  assert.equal(
    resolveBackendBaseUrl({ isDev: true }),
    PRODUCTION_API_BASE
  );
});
