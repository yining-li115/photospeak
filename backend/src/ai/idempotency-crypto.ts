import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const MAX_RESULT_PLAINTEXT_BYTES = 6 * 1024 * 1024;
const MAX_RESULT_ENVELOPE_BYTES = 9 * 1024 * 1024;
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export interface AiCryptoConfig {
  activeKeyId: string;
  encryptionKeys: ReadonlyMap<string, Buffer>;
  activeHmacKeyId: string;
  hmacKeys: ReadonlyMap<string, Buffer>;
}

/** Parse a JSON key ring without ever exposing key material in errors/logs. */
export function parseAiCryptoConfig(input: {
  activeKeyId: string;
  keyRingJson: string;
  activeHmacKeyId: string;
  hmacKeyRingJson: string;
}): AiCryptoConfig {
  if (!KEY_ID_RE.test(input.activeKeyId)) {
    throw new Error('AI_IDEMPOTENCY_ACTIVE_KEY_ID is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.keyRingJson);
  } catch {
    throw new Error('AI_IDEMPOTENCY_KEY_RING must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AI_IDEMPOTENCY_KEY_RING must be a JSON object');
  }
  const encryptionKeys = new Map<string, Buffer>();
  for (const [keyId, encoded] of Object.entries(parsed)) {
    if (!KEY_ID_RE.test(keyId) || typeof encoded !== 'string') {
      throw new Error('AI idempotency key ring contains an invalid entry');
    }
    encryptionKeys.set(keyId, decode32ByteKey(encoded, 'key ring'));
  }
  if (!encryptionKeys.has(input.activeKeyId)) {
    throw new Error('AI idempotency active key is missing from the key ring');
  }
  if (!KEY_ID_RE.test(input.activeHmacKeyId)) {
    throw new Error('AI_IDEMPOTENCY_HMAC_ACTIVE_KEY_ID is invalid');
  }
  const hmacKeys = parseKeyRing(
    input.hmacKeyRingJson,
    'AI_IDEMPOTENCY_HMAC_KEY_RING',
    'HMAC key ring'
  );
  if (!hmacKeys.has(input.activeHmacKeyId)) {
    throw new Error('AI idempotency active HMAC key is missing from the key ring');
  }
  return {
    activeKeyId: input.activeKeyId,
    encryptionKeys,
    activeHmacKeyId: input.activeHmacKeyId,
    hmacKeys,
  };
}

export class AiRequestHasher {
  constructor(
    readonly activeRequestHashKeyId: string,
    private readonly requestHashKeys: ReadonlyMap<string, Buffer>
  ) {
    if (!KEY_ID_RE.test(activeRequestHashKeyId)) {
      throw new Error('AI request hash active key id is invalid');
    }
    if (!requestHashKeys.has(activeRequestHashKeyId)) {
      throw new Error('AI request hash active key is unavailable');
    }
    for (const key of requestHashKeys.values()) {
      if (key.byteLength !== KEY_BYTES) {
        throw new Error('AI request HMAC key must be 32 bytes');
      }
    }
  }

  idempotencyKeyHash(input: {
    userId: string;
    capability: string;
    idempotencyKey: string;
  }): string {
    // Mobile keys carry at least 122 random bits. A stable, domain-separated
    // digest is safe for lookup and must not change when payload-HMAC keys
    // rotate; no user content enters this digest.
    return createHash('sha256')
      .update('photospeak:ai-idempotency:key-lookup:v1\0', 'utf8')
      .update(input.userId, 'utf8')
      .update('\0', 'utf8')
      .update(input.capability, 'utf8')
      .update('\0', 'utf8')
      .update(input.idempotencyKey, 'utf8')
      .digest('hex');
  }

  requestHash(
    input: {
      capability: string;
      contractVersion: number;
      request: unknown;
    },
    keyId = this.activeRequestHashKeyId
  ): string {
    const key = this.requestHashKeys.get(keyId);
    if (!key) {
      throw new Error(`AI request HMAC key is unavailable: ${keyId}`);
    }
    return createHmac('sha256', key)
      .update('photospeak:ai-idempotency:request:v1\0', 'utf8')
      .update(input.capability, 'utf8')
      .update('\0', 'utf8')
      .update(String(input.contractVersion), 'utf8')
      .update('\0', 'utf8')
      .update(canonicalJson(input.request), 'utf8')
      .digest('hex');
  }

  configuredRequestHashKeyIds(): ReadonlySet<string> {
    return new Set(this.requestHashKeys.keys());
  }
}

export function missingRequestHashKeyIds(
  referencedKeyIds: Iterable<string>,
  configuredKeyIds: ReadonlySet<string>
): string[] {
  return [...new Set(referencedKeyIds)]
    .filter((keyId) => !configuredKeyIds.has(keyId))
    .sort();
}

export class AiResultVault {
  private readonly activeKey: Buffer;

  constructor(private readonly config: AiCryptoConfig) {
    const active = config.encryptionKeys.get(config.activeKeyId);
    if (!active) throw new Error('AI result vault active key is missing');
    this.activeKey = active;
  }

  seal(input: {
    operationId: string;
    userId: string;
    capability: string;
    requestHash: string;
    value: unknown;
  }): string {
    const plaintext = Buffer.from(JSON.stringify(input.value), 'utf8');
    if (
      plaintext.byteLength === 0 ||
      plaintext.byteLength > MAX_RESULT_PLAINTEXT_BYTES
    ) {
      throw new Error('AI idempotency result exceeds the encrypted cache limit');
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.activeKey, iv);
    cipher.setAAD(resultAad(input, this.config.activeKeyId));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    return [
      'v1',
      this.config.activeKeyId,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  open(input: {
    operationId: string;
    userId: string;
    capability: string;
    requestHash: string;
    envelope: string;
  }): unknown {
    try {
      if (Buffer.byteLength(input.envelope, 'utf8') > MAX_RESULT_ENVELOPE_BYTES) {
        throw new Error('oversized envelope');
      }
      const [version, keyId, encodedIv, encodedTag, encodedCiphertext, extra] =
        input.envelope.split('.');
      if (
        version !== 'v1' ||
        !keyId ||
        !encodedIv ||
        !encodedTag ||
        !encodedCiphertext ||
        extra !== undefined ||
        !KEY_ID_RE.test(keyId)
      ) {
        throw new Error('invalid envelope');
      }
      const key = this.config.encryptionKeys.get(keyId);
      if (!key) throw new Error('unknown key');
      const iv = Buffer.from(encodedIv, 'base64url');
      const tag = Buffer.from(encodedTag, 'base64url');
      const ciphertext = Buffer.from(encodedCiphertext, 'base64url');
      if (
        iv.byteLength !== IV_BYTES ||
        tag.byteLength !== TAG_BYTES ||
        ciphertext.byteLength === 0 ||
        ciphertext.byteLength > MAX_RESULT_PLAINTEXT_BYTES + TAG_BYTES
      ) {
        throw new Error('invalid envelope lengths');
      }
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(resultAad(input, keyId));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString('utf8')) as unknown;
    } catch {
      throw new Error('AI idempotency result envelope is invalid');
    }
  }
}

export function isSameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite request number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('Unsupported request value');
}

function resultAad(
  input: {
    operationId: string;
    userId: string;
    capability: string;
    requestHash: string;
  },
  keyId: string
): Buffer {
  return Buffer.from(
    `photospeak:ai-result:v1:${keyId}:${input.operationId}:${input.userId}:${input.capability}:${input.requestHash}`,
    'utf8'
  );
}

function decode32ByteKey(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`AI idempotency ${label} is not canonical base64`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength !== KEY_BYTES) {
    throw new Error(`AI idempotency ${label} must decode to 32 bytes`);
  }
  return decoded;
}

function parseKeyRing(
  json: string,
  variableName: string,
  label: string
): ReadonlyMap<string, Buffer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`${variableName} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${variableName} must be a JSON object`);
  }
  const keys = new Map<string, Buffer>();
  for (const [keyId, encoded] of Object.entries(parsed)) {
    if (!KEY_ID_RE.test(keyId) || typeof encoded !== 'string') {
      throw new Error(`AI idempotency ${label} contains an invalid entry`);
    }
    keys.set(keyId, decode32ByteKey(encoded, label));
  }
  return keys;
}
