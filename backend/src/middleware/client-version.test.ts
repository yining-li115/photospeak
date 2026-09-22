import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { requireSupportedClient } from './client-version.js';

function appWithPolicy() {
  const app = new Hono();
  app.use(
    '*',
    requireSupportedClient({ iosMinimumBuild: 3, androidMinimumBuild: 7 })
  );
  app.get('/', (c) => c.json({ ok: true }));
  return app;
}

test('client build gate accepts current builds and rejects old or missing ones', async () => {
  const app = appWithPolicy();
  const current = await app.request('/', {
    headers: { 'X-Client-Platform': 'ios', 'X-Client-Build': '3' },
  });
  assert.equal(current.status, 200);

  const old = await app.request('/', {
    headers: { 'X-Client-Platform': 'android', 'X-Client-Build': '6' },
  });
  assert.equal(old.status, 426);
  const body = (await old.json()) as { code?: string };
  assert.equal(body.code, 'APP_UPDATE_REQUIRED');

  const missing = await app.request('/');
  assert.equal(missing.status, 426);
});

test('a platform with no configured minimum remains available', async () => {
  const app = new Hono();
  app.use('*', requireSupportedClient({ iosMinimumBuild: 3 }));
  app.get('/', (c) => c.text('ok'));
  const response = await app.request('/', {
    headers: { 'X-Client-Platform': 'android' },
  });
  assert.equal(response.status, 200);
});
