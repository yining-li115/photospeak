import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSameAppleSubject } from './apple-server.js';
import { compensateAppleCredential } from './apple-compensation.js';

test('identity mismatch plus revoke failure queues the sealed orphan credential', async () => {
  let identityFailure: unknown;
  try {
    assertSameAppleSubject('verified-client-sub', 'different-exchange-sub');
  } catch (error) {
    identityFailure = error;
  }
  assert.ok(identityFailure instanceof Error);

  let queued = false;
  const result = await compensateAppleCredential({
    revoke: async () => {
      throw new Error('simulated Apple outage');
    },
    enqueue: async () => {
      // The caller has already sealed/hashed the credential before identity
      // verification, so this represents the durable orphan insert.
      queued = true;
    },
  });
  assert.equal(result, 'queued');
  assert.equal(queued, true);
});

test('failed revoke reports unrecoverable when durable enqueue also fails', async () => {
  const result = await compensateAppleCredential({
    revoke: async () => {
      throw new Error('simulated Apple outage');
    },
    enqueue: async () => {
      throw new Error('simulated database outage');
    },
  });
  assert.equal(result, 'unrecoverable');
});
