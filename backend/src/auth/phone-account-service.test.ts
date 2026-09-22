import assert from 'node:assert/strict';
import test from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@localhost/unused';
process.env.JWT_SECRET ||= 'test-only-jwt-secret-that-is-long-enough-123456';

test('phone restore locks the eligible row and enforces the cutoff in SQL', async () => {
  const { buildPhoneAccountLockQuery } = await import(
    './phone-account-service.js'
  );
  const cutoff = new Date('2026-09-12T12:00:00Z');
  const now = new Date('2026-09-19T12:00:00Z');
  const query = new PgDialect().sqlToQuery(
    buildPhoneAccountLockQuery({ phone: '13800138000', cutoff, now })
  );
  const normalized = query.sql.replace(/\s+/g, ' ').trim();
  assert.match(normalized, /deleted_at"? >= /);
  assert.match(normalized, /deleted_at"? < /);
  assert.match(normalized, /for update$/);
  assert.ok(query.params.includes(cutoff));
  assert.ok(query.params.includes(now));
});

test('phone restore includes the seven-day boundary but rejects future rows', async () => {
  const { isPhoneAccountRestoreEligible } = await import(
    './phone-account-service.js'
  );
  const now = new Date('2026-09-19T12:00:00Z');
  assert.equal(
    isPhoneAccountRestoreEligible({
      deletedAt: new Date('2026-09-12T12:00:00Z'),
      now,
    }),
    true
  );
  assert.equal(
    isPhoneAccountRestoreEligible({
      deletedAt: new Date('2026-09-12T11:59:59Z'),
      now,
    }),
    false
  );
  assert.equal(
    isPhoneAccountRestoreEligible({
      deletedAt: new Date('2026-09-19T12:00:01Z'),
      now,
    }),
    false
  );
});
