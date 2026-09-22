import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { isIP } from 'node:net';
import { importPKCS8, SignJWT } from 'jose';

const APPLE_AUDIENCE = 'https://appleid.apple.com';
const APPLE_TOKEN_URL = `${APPLE_AUDIENCE}/auth/token`;
const APPLE_REVOKE_URL = `${APPLE_AUDIENCE}/auth/revoke`;
const CLIENT_SECRET_TTL_SECONDS = 5 * 60;
const MAX_APPLE_RESPONSE_BYTES = 64 * 1024;
const MAX_REFRESH_TOKEN_BYTES = 32 * 1024;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const ENVELOPE_VERSION = 'v1';

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface AppleServerConfig {
  teamId: string;
  keyId: string;
  clientId: string;
  privateKeyPem: string;
  tokenEncryptionKey: Uint8Array;
  tokenEncryptionKeyId?: string;
  tokenDecryptionKeys?: Readonly<Record<string, Uint8Array>>;
  redirectUri?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export interface AppleTokenExchange {
  idToken: string;
  refreshToken: string;
}

export interface AppleServerTokenGateway {
  readonly clientId: string;
  readonly encryptionKeyId: string;
  exchangeAuthorizationCode(code: string): Promise<AppleTokenExchange>;
  revokeRefreshToken(refreshToken: string): Promise<void>;
  sealRefreshToken(refreshToken: string, appleSubject: string): string;
  openRefreshToken(envelope: string, appleSubject: string): string;
}

export type AppleServerErrorKind =
  | 'network'
  | 'rejected'
  | 'invalid_response';

/** Safe operational error: it never includes an auth code, token, or key. */
export class AppleServerError extends Error {
  constructor(
    readonly kind: AppleServerErrorKind,
    readonly httpStatus?: number,
    readonly upstreamCode?: string
  ) {
    super(`Apple server request failed (${kind})`);
    this.name = 'AppleServerError';
  }
}

export class AppleCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppleCredentialError';
  }
}

export class AppleIdentityMismatchError extends Error {
  constructor() {
    super('Apple token subjects do not match');
    this.name = 'AppleIdentityMismatchError';
  }
}

export function assertSameAppleSubject(
  suppliedSubject: string,
  exchangedSubject: string
): void {
  if (!suppliedSubject || suppliedSubject !== exchangedSubject) {
    throw new AppleIdentityMismatchError();
  }
}

export function hashAppleRefreshToken(refreshToken: string): string {
  return createHash('sha256').update(refreshToken, 'utf8').digest('hex');
}

export async function createAppleClientSecret(
  config: Pick<
    AppleServerConfig,
    'teamId' | 'keyId' | 'clientId' | 'privateKeyPem'
  >,
  now = new Date()
): Promise<string> {
  validateIdentifiers(config);
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if (!Number.isSafeInteger(nowSeconds)) {
    throw new Error('Invalid time for Apple client secret');
  }
  const privateKey = await importPKCS8(config.privateKeyPem, 'ES256');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: config.keyId })
    .setIssuer(config.teamId)
    .setSubject(config.clientId)
    .setAudience(APPLE_AUDIENCE)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + CLIENT_SECRET_TTL_SECONDS)
    .sign(privateKey);
}

/**
 * Apple REST client plus an application-level credential vault. The vault is
 * deliberately exposed through an interface so it can later be replaced by
 * KMS/envelope encryption without changing the auth routes.
 */
export class AppleServerTokenService implements AppleServerTokenGateway {
  readonly clientId: string;
  readonly encryptionKeyId: string;
  private readonly config: AppleServerConfig;
  private readonly encryptionKey: Buffer;
  private readonly decryptionKeys: ReadonlyMap<string, Buffer>;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(config: AppleServerConfig) {
    validateIdentifiers(config);
    if (config.tokenEncryptionKey.byteLength !== 32) {
      throw new Error('APPLE_TOKEN_ENCRYPTION_KEY must decode to 32 bytes');
    }
    if (config.redirectUri) validateRedirectUri(config.redirectUri);
    const encryptionKeyId = config.tokenEncryptionKeyId ?? 'primary';
    validateEncryptionKeyId(encryptionKeyId);
    const timeoutMs = config.timeoutMs ?? 10_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
      throw new Error('APPLE_HTTP_TIMEOUT_MS must be between 1000 and 30000');
    }
    this.config = config;
    this.clientId = config.clientId;
    this.encryptionKeyId = encryptionKeyId;
    this.encryptionKey = Buffer.from(config.tokenEncryptionKey);
    const decryptionKeys = new Map<string, Buffer>([
      [encryptionKeyId, this.encryptionKey],
    ]);
    for (const [keyId, key] of Object.entries(
      config.tokenDecryptionKeys ?? {}
    )) {
      validateEncryptionKeyId(keyId);
      if (key.byteLength !== 32) {
        throw new Error(`Apple token decryption key ${keyId} is not 32 bytes`);
      }
      if (keyId === encryptionKeyId) {
        if (!timingSafeEqual(Buffer.from(key), this.encryptionKey)) {
          throw new Error(
            'Current Apple token encryption key id has conflicting key material'
          );
        }
        continue;
      }
      decryptionKeys.set(keyId, Buffer.from(key));
    }
    this.decryptionKeys = decryptionKeys;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = timeoutMs;
  }

  async exchangeAuthorizationCode(code: string): Promise<AppleTokenExchange> {
    if (!code || Buffer.byteLength(code, 'utf8') > 10_000) {
      throw new AppleServerError('invalid_response');
    }
    const form = new URLSearchParams({
      client_id: this.clientId,
      client_secret: await createAppleClientSecret(this.config),
      code,
      grant_type: 'authorization_code',
    });
    if (this.config.redirectUri) {
      form.set('redirect_uri', this.config.redirectUri);
    }

    const response = await this.postForm(APPLE_TOKEN_URL, form);
    const body = parseJsonObject(response.body);
    const idToken = body.id_token;
    const refreshToken = body.refresh_token;
    if (
      typeof idToken !== 'string' ||
      idToken.length === 0 ||
      typeof refreshToken !== 'string' ||
      refreshToken.length === 0 ||
      Buffer.byteLength(refreshToken, 'utf8') > MAX_REFRESH_TOKEN_BYTES
    ) {
      throw new AppleServerError('invalid_response', response.status);
    }
    return { idToken, refreshToken };
  }

  async revokeRefreshToken(refreshToken: string): Promise<void> {
    if (
      !refreshToken ||
      Buffer.byteLength(refreshToken, 'utf8') > MAX_REFRESH_TOKEN_BYTES
    ) {
      throw new AppleCredentialError('Invalid Apple refresh token');
    }
    const form = new URLSearchParams({
      client_id: this.clientId,
      client_secret: await createAppleClientSecret(this.config),
      token: refreshToken,
      token_type_hint: 'refresh_token',
    });
    await this.postForm(APPLE_REVOKE_URL, form);
  }

  sealRefreshToken(refreshToken: string, appleSubject: string): string {
    if (
      !refreshToken ||
      Buffer.byteLength(refreshToken, 'utf8') > MAX_REFRESH_TOKEN_BYTES ||
      !appleSubject
    ) {
      throw new AppleCredentialError('Invalid Apple credential input');
    }
    const iv = randomBytes(GCM_IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(credentialAad(appleSubject, this.encryptionKeyId));
    const ciphertext = Buffer.concat([
      cipher.update(refreshToken, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      ENVELOPE_VERSION,
      this.encryptionKeyId,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  openRefreshToken(envelope: string, appleSubject: string): string {
    try {
      const parts = envelope.split('.');
      if (
        parts.length !== 5 ||
        parts[0] !== ENVELOPE_VERSION ||
        !parts[1] ||
        !parts[2] ||
        !parts[3] ||
        !parts[4] ||
        !appleSubject
      ) {
        throw new Error('bad envelope');
      }
      const keyId = parts[1];
      validateEncryptionKeyId(keyId);
      const key = this.decryptionKeys.get(keyId);
      if (!key) throw new Error('unknown encryption key');
      const iv = decodeBase64Url(parts[2]);
      const tag = decodeBase64Url(parts[3]);
      const ciphertext = decodeBase64Url(parts[4]);
      if (
        iv.byteLength !== GCM_IV_BYTES ||
        tag.byteLength !== GCM_TAG_BYTES ||
        ciphertext.byteLength === 0 ||
        ciphertext.byteLength > MAX_REFRESH_TOKEN_BYTES
      ) {
        throw new Error('bad envelope lengths');
      }
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        iv
      );
      decipher.setAAD(credentialAad(appleSubject, keyId));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString('utf8');
      if (!plaintext || Buffer.byteLength(plaintext) > MAX_REFRESH_TOKEN_BYTES) {
        throw new Error('bad plaintext');
      }
      return plaintext;
    } catch {
      throw new AppleCredentialError('Apple credential cannot be decrypted');
    }
  }

  private async postForm(
    url: string,
    form: URLSearchParams
  ): Promise<{ status: number; body: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        signal: controller.signal,
      });
      const body = await readLimitedResponseBody(
        response,
        MAX_APPLE_RESPONSE_BYTES
      );
      if (!response.ok) {
        const retryable =
          response.status >= 500 ||
          response.status === 408 ||
          response.status === 429;
        throw new AppleServerError(
          retryable ? 'network' : 'rejected',
          response.status,
          parseAppleErrorCode(body)
        );
      }
      return { status: response.status, body };
    } catch (error) {
      if (error instanceof AppleServerError) throw error;
      throw new AppleServerError('network');
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readLimitedResponseBody(
  response: Response,
  maxBytes: number
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new AppleServerError('invalid_response', response.status);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new AppleServerError('invalid_response', response.status);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString(
    'utf8'
  );
}

export function createAppleServerTokenServiceFromEnv(
  fallbackClientId: string
): AppleServerTokenService {
  const teamId = requireEnvironment('APPLE_TEAM_ID');
  const keyId = requireEnvironment('APPLE_KEY_ID');
  const clientId = process.env.APPLE_CLIENT_ID?.trim() || fallbackClientId;
  const privateKeyPem = normalizePrivateKey(
    requireEnvironment('APPLE_PRIVATE_KEY_PEM')
  );
  const tokenEncryptionKey = decodeEncryptionKey(
    requireEnvironment('APPLE_TOKEN_ENCRYPTION_KEY')
  );
  const tokenEncryptionKeyId =
    process.env.APPLE_TOKEN_ENCRYPTION_KEY_ID?.trim() || 'primary';
  const tokenDecryptionKeys = decodeDecryptionKeyRing(
    process.env.APPLE_TOKEN_DECRYPTION_KEYS
  );
  const timeoutValue = Number(process.env.APPLE_HTTP_TIMEOUT_MS ?? 10_000);
  return new AppleServerTokenService({
    teamId,
    keyId,
    clientId,
    privateKeyPem,
    tokenEncryptionKey,
    tokenEncryptionKeyId,
    tokenDecryptionKeys,
    redirectUri: process.env.APPLE_REDIRECT_URI?.trim() || undefined,
    timeoutMs: timeoutValue,
  });
}

function validateIdentifiers(
  config: Pick<AppleServerConfig, 'teamId' | 'keyId' | 'clientId' | 'privateKeyPem'>
): void {
  if (!/^[A-Z0-9]{10}$/.test(config.teamId)) {
    throw new Error('APPLE_TEAM_ID must be a 10-character identifier');
  }
  if (!/^[A-Z0-9]{10}$/.test(config.keyId)) {
    throw new Error('APPLE_KEY_ID must be a 10-character identifier');
  }
  if (
    !config.clientId ||
    config.clientId.length > 255 ||
    /\s/.test(config.clientId)
  ) {
    throw new Error('APPLE_CLIENT_ID is invalid');
  }
  if (!config.privateKeyPem.includes('-----BEGIN PRIVATE KEY-----')) {
    throw new Error('APPLE_PRIVATE_KEY_PEM must contain a PKCS#8 private key');
  }
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalizePrivateKey(value: string): string {
  return value.replace(/\\n/g, '\n').trim();
}

function decodeEncryptionKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error(
      'APPLE_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key'
    );
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength !== 32 || decoded.toString('base64') !== value) {
    throw new Error(
      'APPLE_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key'
    );
  }
  return decoded;
}

function decodeDecryptionKeyRing(
  value: string | undefined
): Readonly<Record<string, Uint8Array>> {
  if (!value?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('APPLE_TOKEN_DECRYPTION_KEYS must be a JSON object');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('APPLE_TOKEN_DECRYPTION_KEYS must be a JSON object');
  }
  const result: Record<string, Uint8Array> = {};
  for (const [keyId, encoded] of Object.entries(
    parsed as Record<string, unknown>
  )) {
    validateEncryptionKeyId(keyId);
    if (typeof encoded !== 'string') {
      throw new Error('APPLE_TOKEN_DECRYPTION_KEYS values must be base64');
    }
    result[keyId] = decodeEncryptionKey(encoded);
  }
  return result;
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('bad base64url');
  const decoded = Buffer.from(value, 'base64url');
  // Node accepts non-canonical trailing bits. Reject them so changing the
  // textual envelope can never decode to the same authenticated bytes.
  if (decoded.toString('base64url') !== value) {
    throw new Error('non-canonical base64url');
  }
  return decoded;
}

function credentialAad(appleSubject: string, keyId: string): Buffer {
  return Buffer.from(
    `photospeak:apple-refresh:v1:${keyId}:${appleSubject}`,
    'utf8'
  );
}

function validateEncryptionKeyId(keyId: string): void {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(keyId)) {
    throw new Error('Apple token encryption key id is invalid');
  }
}

function validateRedirectUri(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('APPLE_REDIRECT_URI must be a valid HTTPS URL');
  }
  if (
    value.length > 2_048 ||
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.hostname === 'localhost' ||
    isIP(url.hostname) !== 0 ||
    url.hash
  ) {
    throw new Error('APPLE_REDIRECT_URI must be a public HTTPS URL');
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new AppleServerError('invalid_response');
  }
}

function parseAppleErrorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const value = (parsed as Record<string, unknown>).error;
    return typeof value === 'string' && /^[a-z_]{1,64}$/.test(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
