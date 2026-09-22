import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';

const TEST_SECRET = 'test-secret-that-is-long-enough-for-hs256-1234567890';
process.env.JWT_SECRET = TEST_SECRET;
process.env.JWT_ISSUER = 'photospeak-test-api';
process.env.JWT_AUDIENCE = 'photospeak-test-mobile';
process.env.JWT_EXPIRES_IN = '15m';
process.env.JWT_REFRESH_EXPIRES_IN = '30d';
process.env.AUTH_RECENT_MAX_AGE_SECONDS = '600';

const jwtModule = import('./jwt.js');

function context() {
  return {
    userId: 'user-123',
    sessionId: 'session-123',
    authenticatedAt: new Date(),
  };
}

test('issued JWT fixes algorithm, issuer, audience, session and exact exp', async () => {
  const { issueRefreshToken, verifyToken } = await jwtModule;
  const issued = issueRefreshToken(context());
  const complete = jwt.decode(issued.token, { complete: true });
  assert.equal(complete?.header.alg, 'HS256');
  const verified = verifyToken(issued.token, 'refresh');
  assert.equal(verified.iss, 'photospeak-test-api');
  assert.equal(verified.aud, 'photospeak-test-mobile');
  assert.equal(verified.sid, 'session-123');
  assert.equal(issued.expiresAt.getTime(), verified.exp * 1_000);
});

test('refresh rotation can preserve an absolute family expiry', async () => {
  const { issueRefreshToken } = await jwtModule;
  const absolute = new Date(Date.now() + 60 * 60 * 1_000);
  absolute.setMilliseconds(0);
  const issued = issueRefreshToken(context(), absolute);
  assert.equal(issued.expiresAt.getTime(), absolute.getTime());
});

test('verification rejects wrong algorithm, issuer, audience and token kind', async () => {
  const { issueRefreshToken, verifyToken } = await jwtModule;
  const now = Math.floor(Date.now() / 1_000);
  const base = {
    sub: 'user-123',
    sid: 'session-123',
    kind: 'access',
    auth_time: now,
  };
  const wrongAlgorithm = jwt.sign(base, TEST_SECRET, {
    algorithm: 'HS512',
    issuer: 'photospeak-test-api',
    audience: 'photospeak-test-mobile',
    expiresIn: 900,
    jwtid: 'wrong-algorithm',
  });
  const wrongIssuer = jwt.sign(base, TEST_SECRET, {
    algorithm: 'HS256',
    issuer: 'other-api',
    audience: 'photospeak-test-mobile',
    expiresIn: 900,
    jwtid: 'wrong-issuer',
  });
  const wrongAudience = jwt.sign(base, TEST_SECRET, {
    algorithm: 'HS256',
    issuer: 'photospeak-test-api',
    audience: 'other-mobile-client',
    expiresIn: 900,
    jwtid: 'wrong-audience',
  });
  assert.throws(() => verifyToken(wrongAlgorithm, 'access'));
  assert.throws(() => verifyToken(wrongIssuer, 'access'));
  assert.throws(() => verifyToken(wrongAudience, 'access'));
  assert.throws(() => verifyToken(issueRefreshToken(context()).token, 'access'));
});

test('verification rejects a signed access token exceeding configured TTL', async () => {
  const { verifyToken } = await jwtModule;
  const now = Math.floor(Date.now() / 1_000);
  const tooLong = jwt.sign(
    {
      sub: 'user-123',
      sid: 'session-123',
      kind: 'access',
      auth_time: now,
    },
    TEST_SECRET,
    {
      algorithm: 'HS256',
      issuer: 'photospeak-test-api',
      audience: 'photospeak-test-mobile',
      expiresIn: 3_600,
      jwtid: 'too-long',
    }
  );
  assert.throws(() => verifyToken(tooLong, 'access'));
});

test('recent authentication window has a hard boundary', async () => {
  const { isRecentAuthentication } = await jwtModule;
  const now = new Date('2026-09-19T12:00:00.000Z');
  assert.equal(
    isRecentAuthentication(new Date('2026-09-19T11:50:00.000Z'), now, 600),
    true
  );
  assert.equal(
    isRecentAuthentication(new Date('2026-09-19T11:49:59.000Z'), now, 600),
    false
  );
});
