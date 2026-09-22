import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import {
  decodeProtectedHeader,
  importSPKI,
  jwtVerify,
} from 'jose';
import {
  AppleCredentialError,
  AppleIdentityMismatchError,
  AppleServerError,
  AppleServerTokenService,
  assertSameAppleSubject,
  createAppleClientSecret,
  type AppleServerConfig,
} from './apple-server.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
});
const privateKeyPem = privateKey.export({
  format: 'pem',
  type: 'pkcs8',
}).toString();
const publicKeyPem = publicKey.export({
  format: 'pem',
  type: 'spki',
}).toString();

function config(
  fetchImpl: NonNullable<AppleServerConfig['fetchImpl']>
): AppleServerConfig {
  return {
    teamId: 'TEAMID1234',
    keyId: 'KEYID12345',
    clientId: 'com.example.photospeak',
    privateKeyPem,
    tokenEncryptionKey: Buffer.alloc(32, 7),
    timeoutMs: 1_000,
    fetchImpl,
  };
}

test('Apple client secret is a short-lived ES256 JWT with official claims', async () => {
  const now = new Date('2026-09-19T12:00:00.000Z');
  const secret = await createAppleClientSecret(
    config(async () => new Response()),
    now
  );
  const header = decodeProtectedHeader(secret);
  assert.equal(header.alg, 'ES256');
  assert.equal(header.kid, 'KEYID12345');

  const verificationKey = await importSPKI(publicKeyPem, 'ES256');
  const { payload } = await jwtVerify(secret, verificationKey, {
    issuer: 'TEAMID1234',
    audience: 'https://appleid.apple.com',
    subject: 'com.example.photospeak',
    currentDate: now,
  });
  assert.equal(payload.exp! - payload.iat!, 300);
});

test('authorization code exchange and refresh-token revocation use locked forms', async () => {
  const requests: { url: string; form: URLSearchParams }[] = [];
  const service = new AppleServerTokenService(
    config(async (input, init) => {
      requests.push({
        url: String(input),
        form: new URLSearchParams(String(init?.body)),
      });
      if (String(input).endsWith('/auth/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'not-stored',
            token_type: 'Bearer',
            expires_in: 3_600,
            refresh_token: 'apple-refresh-token',
            id_token: 'apple-id-token',
          }),
          { status: 200 }
        );
      }
      return new Response('', { status: 200 });
    })
  );

  assert.deepEqual(await service.exchangeAuthorizationCode('one-use-code'), {
    idToken: 'apple-id-token',
    refreshToken: 'apple-refresh-token',
  });
  await service.revokeRefreshToken('apple-refresh-token');

  assert.equal(requests[0]?.url, 'https://appleid.apple.com/auth/token');
  assert.equal(requests[0]?.form.get('client_id'), 'com.example.photospeak');
  assert.equal(requests[0]?.form.get('code'), 'one-use-code');
  assert.equal(requests[0]?.form.get('grant_type'), 'authorization_code');
  assert.equal(requests[0]?.form.has('redirect_uri'), false);
  assert.ok(requests[0]?.form.get('client_secret'));
  assert.equal(requests[1]?.url, 'https://appleid.apple.com/auth/revoke');
  assert.equal(requests[1]?.form.get('token'), 'apple-refresh-token');
  assert.equal(requests[1]?.form.get('token_type_hint'), 'refresh_token');
});

test('Apple refresh tokens use authenticated encryption bound to the subject', () => {
  const service = new AppleServerTokenService(
    config(async () => new Response('', { status: 200 }))
  );
  const sealed = service.sealRefreshToken('refresh-secret', 'apple-subject-1');
  assert.notEqual(sealed, 'refresh-secret');
  assert.equal(
    service.openRefreshToken(sealed, 'apple-subject-1'),
    'refresh-secret'
  );
  assert.throws(
    () => service.openRefreshToken(sealed, 'apple-subject-2'),
    AppleCredentialError
  );
  assert.throws(
    () =>
      service.openRefreshToken(
        `${sealed.slice(0, -1)}${sealed.endsWith('A') ? 'B' : 'A'}`,
        'apple-subject-1'
      ),
    AppleCredentialError
  );
});

test('encrypted credential envelopes retain a key id for safe rotation', () => {
  const noNetwork = async () => new Response('', { status: 200 });
  const oldKey = Buffer.alloc(32, 3);
  const newKey = Buffer.alloc(32, 9);
  const oldService = new AppleServerTokenService({
    ...config(noNetwork),
    tokenEncryptionKey: oldKey,
    tokenEncryptionKeyId: 'key-2026-a',
  });
  const sealed = oldService.sealRefreshToken('rotatable-token', 'apple-sub');
  assert.match(sealed, /^v1\.key-2026-a\./);

  const rotatedService = new AppleServerTokenService({
    ...config(noNetwork),
    tokenEncryptionKey: newKey,
    tokenEncryptionKeyId: 'key-2026-b',
    tokenDecryptionKeys: { 'key-2026-a': oldKey },
  });
  assert.equal(
    rotatedService.openRefreshToken(sealed, 'apple-sub'),
    'rotatable-token'
  );
  const missingOldKey = new AppleServerTokenService({
    ...config(noNetwork),
    tokenEncryptionKey: newKey,
    tokenEncryptionKeyId: 'key-2026-b',
  });
  assert.throws(
    () => missingOldKey.openRefreshToken(sealed, 'apple-sub'),
    AppleCredentialError
  );
  assert.throws(
    () =>
      new AppleServerTokenService({
        ...config(noNetwork),
        tokenEncryptionKey: newKey,
        tokenEncryptionKeyId: 'key-2026-b',
        tokenDecryptionKeys: { 'key-2026-b': oldKey },
      }),
    /conflicting key material/
  );
});

test('Apple response bodies are capped while streaming', async () => {
  const service = new AppleServerTokenService(
    config(async () => new Response('x'.repeat(65 * 1024), { status: 200 }))
  );
  await assert.rejects(
    () => service.exchangeAuthorizationCode('one-use-code'),
    (error: unknown) => {
      assert.ok(error instanceof AppleServerError);
      assert.equal(error.kind, 'invalid_response');
      return true;
    }
  );
});

test('Apple upstream failures expose only classified metadata', async () => {
  const service = new AppleServerTokenService(
    config(async () =>
      new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'must-never-reach-logs-or-clients',
        }),
        { status: 400 }
      )
    )
  );
  await assert.rejects(
    () => service.exchangeAuthorizationCode('sensitive-code'),
    (error: unknown) => {
      assert.ok(error instanceof AppleServerError);
      assert.equal(error.kind, 'rejected');
      assert.equal(error.httpStatus, 400);
      assert.equal(error.upstreamCode, 'invalid_grant');
      assert.doesNotMatch(error.message, /sensitive|must-never/);
      return true;
    }
  );
});

test('supplied and exchanged Apple identities must be the same user', () => {
  assert.doesNotThrow(() => assertSameAppleSubject('same', 'same'));
  assert.throws(
    () => assertSameAppleSubject('first', 'second'),
    AppleIdentityMismatchError
  );
});
