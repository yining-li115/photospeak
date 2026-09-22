import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import {
  DeletionReceiptService,
  deletionReceiptPublicConfig,
  parseDeletionReceiptKeys,
} from './deletion-receipt.js';

const keyOne = Buffer.alloc(32, 1);
const keyTwo = Buffer.alloc(32, 2);

test('deletion receipt remains verifiable across a signing-key rotation', () => {
  const issuedAt = new Date('2026-01-01T00:00:00Z');
  const oldService = new DeletionReceiptService({
    currentKeyId: '2026-01',
    keys: { '2026-01': keyOne },
  });
  const receipt = oldService.issue('user-123', issuedAt);
  const rotatedService = new DeletionReceiptService({
    currentKeyId: '2026-09',
    keys: { '2026-09': keyTwo, '2026-01': keyOne },
  });

  const nearExpiry = new Date(
    issuedAt.getTime() + 399 * 24 * 60 * 60 * 1_000
  );
  assert.equal(rotatedService.verify(receipt.token, nearExpiry).sub, 'user-123');
  assert.throws(() =>
    new DeletionReceiptService({
      currentKeyId: '2026-09',
      keys: { '2026-09': keyTwo },
    }).verify(receipt.token, nearExpiry)
  );
});

test('deletion receipt is narrow, fixed-algorithm, and expires after 400 days', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const service = new DeletionReceiptService({
    currentKeyId: 'primary',
    keys: { primary: keyOne },
  });
  const receipt = service.issue('user-123', now);
  const complete = jwt.decode(receipt.token, { complete: true });
  assert.equal(complete?.header.alg, 'HS256');
  assert.equal(complete?.header.kid, 'primary');
  assert.equal(
    service.verify(receipt.token, new Date(now.getTime() + 60_000)).kind,
    'deletion_receipt'
  );
  assert.throws(() =>
    service.verify(
      receipt.token,
      new Date(now.getTime() + 401 * 24 * 60 * 60 * 1_000)
    )
  );

  const config = deletionReceiptPublicConfig();
  const accessLike = jwt.sign(
    { sub: 'user-123', kind: 'access' },
    keyOne,
    {
      algorithm: 'HS256',
      issuer: config.issuer,
      audience: config.audience,
      keyid: 'primary',
      expiresIn: 60,
    }
  );
  assert.throws(() => service.verify(accessLike));
});

test('deletion receipt key ring parser requires canonical 32-byte base64 keys', () => {
  assert.deepEqual(
    Object.keys(
      parseDeletionReceiptKeys(
        JSON.stringify({ primary: keyOne.toString('base64') })
      )
    ),
    ['primary']
  );
  assert.throws(() => parseDeletionReceiptKeys('{'));
  assert.throws(() =>
    parseDeletionReceiptKeys(JSON.stringify({ primary: 'too-short' }))
  );
});
