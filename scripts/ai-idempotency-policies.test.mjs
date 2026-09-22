import assert from 'node:assert/strict';
import test from 'node:test';
import { formatAiIdempotencyKey } from '../src/api/idempotency-key.ts';

test('mobile AI intents use the timestamped v2 key contract', () => {
  assert.equal(
    formatAiIdempotencyKey(
      '12345678-1234-4234-9234-123456789ABC',
      Date.parse('2026-01-01T00:00:00.999Z')
    ),
    'v2.1767225600.12345678-1234-4234-9234-123456789abc'
  );
  assert.throws(() =>
    formatAiIdempotencyKey('not-a-uuid', Date.now())
  );
});
