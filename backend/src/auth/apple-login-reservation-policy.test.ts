import assert from 'node:assert/strict';
import test from 'node:test';
import { isAppleLoginReservationCurrent } from './apple-login-reservation-policy.js';

test('deletion or a replacement reservation makes a late Apple login stale', () => {
  const base = {
    expectedId: 'reservation-a',
    actualId: 'reservation-a',
    expiresAt: new Date('2026-09-19T12:02:00Z'),
    now: new Date('2026-09-19T12:01:00Z'),
    mode: 'active' as const,
    deletionState: 'active',
    deleted: false,
  };
  assert.equal(isAppleLoginReservationCurrent(base), true);
  assert.equal(
    isAppleLoginReservationCurrent({ ...base, deletionState: 'deleting' }),
    false
  );
  assert.equal(
    isAppleLoginReservationCurrent({ ...base, actualId: 'reservation-b' }),
    false
  );
  assert.equal(
    isAppleLoginReservationCurrent({ ...base, now: base.expiresAt }),
    false
  );
});

test('restore and provisional reservations require their original state', () => {
  const base = {
    expectedId: 'reservation-a',
    actualId: 'reservation-a',
    expiresAt: new Date('2026-09-19T12:02:00Z'),
    now: new Date('2026-09-19T12:01:00Z'),
    deletionState: 'deleted',
    deleted: true,
  };
  assert.equal(
    isAppleLoginReservationCurrent({ ...base, mode: 'restore' }),
    true
  );
  assert.equal(
    isAppleLoginReservationCurrent({
      ...base,
      mode: 'provision',
      deletionState: 'provisioning',
      deleted: false,
    }),
    true
  );
});
