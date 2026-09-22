import assert from 'node:assert/strict';
import test from 'node:test';
import {
  drainForShutdown,
  type DrainableServer,
} from './graceful-shutdown.js';

test('shutdown stops accepts, waits for relay/http, then closes the database', async () => {
  const events: string[] = [];
  const server: DrainableServer = {
    close(callback) {
      events.push('http:stop');
      setTimeout(() => {
        events.push('http:drained');
        callback();
      }, 5);
    },
    closeIdleConnections() {
      events.push('http:idle-closed');
    },
  };
  const result = await drainForShutdown({
    server,
    timeoutMs: 100,
    closeRelay: async () => {
      events.push('relay:stop');
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          events.push('relay:drained');
          resolve();
        }, 10)
      );
    },
    closeDatabase: async () => {
      events.push('database:closed');
    },
  });
  assert.deepEqual(result, { forced: false, errors: [] });
  assert.equal(events[0], 'http:stop');
  assert.ok(events.indexOf('database:closed') > events.indexOf('http:drained'));
  assert.ok(events.indexOf('database:closed') > events.indexOf('relay:drained'));
});

test('shutdown has an observable hard timeout before database close', async () => {
  const events: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const server: DrainableServer = {
    close() {
      events.push('http:stop');
    },
    closeAllConnections() {
      events.push('http:forced');
    },
  };
  const result = await drainForShutdown({
    server,
    timeoutMs: 5,
    closeRelay: () => new Promise<void>(() => {}),
    closeDatabase: async () => {
      events.push('database:closed');
    },
    log: (record) => logs.push(record),
  });
  assert.equal(result.forced, true);
  assert.deepEqual(events, ['http:stop', 'http:forced', 'database:closed']);
  assert.equal(logs[0]?.event, 'shutdown.force_timeout');
});
