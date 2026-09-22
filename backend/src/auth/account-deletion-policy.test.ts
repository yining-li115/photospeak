import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appleDeletionOutcome,
  decideDeletionStart,
} from './account-deletion-policy.js';

test('same session resumes and another recent session can take over intent', () => {
  const base = {
    deletionState: 'deleting',
    deleted: false,
    authorizedSessionId: 'session-a',
    recentAuthentication: true,
  };
  assert.equal(
    decideDeletionStart({ ...base, currentSessionId: 'session-a' }),
    'resume'
  );
  assert.equal(
    decideDeletionStart({ ...base, currentSessionId: 'session-b' }),
    'takeover'
  );
  assert.equal(
    decideDeletionStart({
      ...base,
      currentSessionId: 'session-b',
      recentAuthentication: false,
    }),
    'recent_auth_required'
  );
});

test('recent authentication is required before deletion intent is persisted', () => {
  const base = {
    deletionState: 'active',
    deleted: false,
    authorizedSessionId: null,
    currentSessionId: 'session-a',
  };
  assert.equal(
    decideDeletionStart({ ...base, recentAuthentication: true }),
    'begin'
  );
  assert.equal(
    decideDeletionStart({ ...base, recentAuthentication: false }),
    'recent_auth_required'
  );
});

test('legacy Apple accounts without durable credentials use manual revocation', () => {
  assert.equal(appleDeletionOutcome(null, 0), 'not_applicable');
  assert.equal(appleDeletionOutcome('apple-sub', 0), 'manual_required');
  assert.equal(appleDeletionOutcome('apple-sub', 2), 'revoked');
});
