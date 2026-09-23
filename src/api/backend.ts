/**
 * Shared HTTP client for talking to our backend (the Node/Hono proxy
 * + auth service on Aliyun). Owns:
 *
 *   1. Resolving the fixed production API origin.
 *   2. SecureStore for access_token + refresh_token.
 *   3. Auto-refreshing on 401 and retrying the original request once.
 *   4. Standard JSON request/response framing.
 *
 * Call sites: auth.ts (login flows), ai.ts / tts.ts
 * (proxied API calls), streaming-asr.ts (to open a one-use session on
 * PhotoSpeak's constrained WebSocket relay; provider credentials never
 * enter the app bundle).
 */
import Constants from 'expo-constants';
import { randomUUID } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { resolveBackendBaseUrl } from './backend-origin';

const BASE = resolveBackendBaseUrl({
  isDev: __DEV__,
});
const DEFAULT_TIMEOUT_MS = 20_000;
const AUTH_EXPIRED_CODE = 'AUTH_ACCESS_EXPIRED';

// Sent on every backend request so the server can correlate users to
// app versions and decide when it's safe to retire deprecated auth
// paths. See docs/optimization.md S1.
const CLIENT_VERSION = Constants.expoConfig?.version ?? 'unknown';
const CLIENT_PLATFORM = Platform.OS;
const CLIENT_BUILD =
  Platform.OS === 'ios'
    ? Constants.expoConfig?.ios?.buildNumber ?? 'unknown'
    : Platform.OS === 'android'
      ? String(Constants.expoConfig?.android?.versionCode ?? 'unknown')
      : 'unknown';

const ACCESS_KEY = 'access_token';
const REFRESH_KEY = 'refresh_token';
const SESSION_KEY = 'auth_session_v2';

export class BackendNotConfiguredError extends Error {
  constructor(message = '后端地址未配置，请重新安装或联系支持人员') {
    super(message);
    this.name = 'BackendNotConfiguredError';
  }
}

/** Public, unauthenticated documents hosted by the trusted API origin. */
export function backendPublicDocumentUrl(
  document: 'privacy' | 'terms' | 'support'
): string {
  assertSafeBaseUrl();
  return new URL(`/${document}`, `${BASE}/`).toString();
}

export class UnauthorizedError extends Error {
  constructor(message = '登录已过期，请重新登录') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class AuthSessionChangedError extends Error {
  constructor(message = '登录账号已切换，请重试') {
    super(message);
    this.name = 'AuthSessionChangedError';
  }
}

export class BackendError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

type AuthExpiredListener = () => void;
const authExpiredListeners = new Set<AuthExpiredListener>();

/**
 * Lets AuthProvider react when a request proves that the local session is no
 * longer valid. Keeping this signal in the HTTP layer avoids circular imports
 * while ensuring the UI and SecureStore cannot drift apart.
 */
export function onAuthExpired(listener: AuthExpiredListener): () => void {
  authExpiredListeners.add(listener);
  return () => authExpiredListeners.delete(listener);
}

function notifyAuthExpired(): void {
  for (const listener of authExpiredListeners) listener();
}

// ─── token storage ─────────────────────────────────────────────────

let cachedAccess: string | null = null;
let cachedRefresh: string | null = null;
let cachedRefreshIdempotencyKey: string | null = null;
let preloadPromise: Promise<void> | null = null;
let sessionEpoch = 0;
let tokenMutationTail: Promise<void> = Promise.resolve();

interface StoredSession {
  version: 2;
  state: 'active' | 'logged_out';
  access_token?: string;
  refresh_token?: string;
  /** Bound to the current refresh token until its replacement is committed. */
  refresh_idempotency_key?: string;
}

function runTokenMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = tokenMutationTail.then(operation, operation);
  tokenMutationTail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function ensurePreloaded(): Promise<void> {
  if (preloadPromise) return preloadPromise;
  const expectedEpoch = sessionEpoch;
  preloadPromise = (async () => {
    try {
      const bundleRaw = await SecureStore.getItemAsync(SESSION_KEY);
      if (sessionEpoch !== expectedEpoch) return;
      if (bundleRaw) {
        const bundle = JSON.parse(bundleRaw) as Partial<StoredSession>;
        if (
          bundle.version === 2 &&
          bundle.state === 'active' &&
          typeof bundle.access_token === 'string' &&
          typeof bundle.refresh_token === 'string'
        ) {
          cachedAccess = bundle.access_token;
          cachedRefresh = bundle.refresh_token;
          cachedRefreshIdempotencyKey = isRefreshIdempotencyKey(
            bundle.refresh_idempotency_key
          )
            ? bundle.refresh_idempotency_key
            : null;
        } else {
          cachedAccess = null;
          cachedRefresh = null;
          cachedRefreshIdempotencyKey = null;
        }
        return;
      }

      // One-time migration from the beta's two-key storage. Once a v2 bundle
      // (including a logged-out tombstone) exists, these keys are ignored.
      const [legacyAccess, legacyRefresh] = await Promise.all([
        SecureStore.getItemAsync(ACCESS_KEY),
        SecureStore.getItemAsync(REFRESH_KEY),
      ]);
      if (sessionEpoch !== expectedEpoch) return;
      cachedAccess = legacyAccess;
      cachedRefresh = legacyRefresh;
      cachedRefreshIdempotencyKey = null;
      if (legacyAccess && legacyRefresh) {
        await SecureStore.setItemAsync(
          SESSION_KEY,
          serializeStoredSession(legacyAccess, legacyRefresh)
        );
      }
    } catch {
      if (sessionEpoch === expectedEpoch) {
        cachedAccess = null;
        cachedRefresh = null;
        cachedRefreshIdempotencyKey = null;
      }
    }
  })();
  return preloadPromise;
}

/** Monotonic identity epoch used to reject late work from a prior account. */
export function getAuthSessionEpoch(): number {
  return sessionEpoch;
}

export function assertAuthSessionEpoch(expectedEpoch: number): void {
  if (sessionEpoch !== expectedEpoch) throw new AuthSessionChangedError();
}

export async function getAccessToken(): Promise<string | null> {
  await ensurePreloaded();
  return cachedAccess;
}

export async function getRefreshToken(): Promise<string | null> {
  await ensurePreloaded();
  return cachedRefresh;
}

export async function setSessionTokens(
  access: string,
  refresh: string
): Promise<void> {
  if (!access || !refresh) throw new Error('Invalid session tokens');
  const expectedEpoch = ++sessionEpoch;
  cachedAccess = access;
  cachedRefresh = refresh;
  cachedRefreshIdempotencyKey = null;
  preloadPromise = Promise.resolve();
  try {
    await runTokenMutation(async () => {
      if (sessionEpoch !== expectedEpoch) return;
      await SecureStore.setItemAsync(
        SESSION_KEY,
        serializeStoredSession(access, refresh)
      );
      await Promise.all([
        SecureStore.deleteItemAsync(ACCESS_KEY).catch(() => {}),
        SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => {}),
      ]);
    });
  } catch (error) {
    if (sessionEpoch === expectedEpoch) {
      await clearSessionTokens().catch(() => {});
    }
    throw error;
  }
}

export async function clearSessionTokens(): Promise<void> {
  const expectedEpoch = ++sessionEpoch;
  cachedAccess = null;
  cachedRefresh = null;
  cachedRefreshIdempotencyKey = null;
  preloadPromise = Promise.resolve();
  await runTokenMutation(async () => {
    if (sessionEpoch !== expectedEpoch) return;
    // A tombstone is safer than deletion: even if legacy-key cleanup fails,
    // the next launch cannot resurrect an old beta refresh token.
    await SecureStore.setItemAsync(
      SESSION_KEY,
      JSON.stringify({ version: 2, state: 'logged_out' } satisfies StoredSession)
    );
    await Promise.all([
      SecureStore.deleteItemAsync(ACCESS_KEY).catch(() => {}),
      SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => {}),
    ]);
  });
}

// ─── request ───────────────────────────────────────────────────────

interface RequestOptions {
  /** Set false on /auth/apple, /auth/send-code, /auth/verify — those
   *  endpoints don't need (and shouldn't fail on) an access token. */
  withAuth?: boolean;
  /** Request deadline. Provider-backed operations may opt into a longer value. */
  timeoutMs?: number;
  /** Optional caller cancellation, composed with the request deadline. */
  signal?: AbortSignal;
  /** Disable the generic 401 refresh path for logout/session mutations. */
  autoRefresh?: boolean;
  /** Bind sensitive payload preparation to the account that started it. */
  expectedAuthEpoch?: number;
  /** Narrow escape hatch for the separately persisted deletion-status
   * credential. Callers must set withAuth=false; it is never refreshed. */
  authorizationToken?: string;
  /** Stable logical-operation identity for billable AI endpoints. */
  idempotencyKey?: string;
}

interface ErrorPayload {
  error?: unknown;
  code?: unknown;
}

function assertSafeBaseUrl(): void {
  if (!BASE) throw new BackendNotConfiguredError();
  if (!__DEV__ && !BASE.startsWith('https://')) {
    throw new BackendNotConfiguredError('生产版本仅允许连接安全的 HTTPS 后端');
  }
}

/** Build a WebSocket URL on the same trusted backend origin. */
export function backendWebSocketUrl(path: string): string {
  assertSafeBaseUrl();
  const url = new URL(path.startsWith('/') ? path : `/${path}`, `${BASE}/`);
  if (url.origin !== new URL(`${BASE}/`).origin) {
    throw new BackendNotConfiguredError('语音连接地址无效');
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

async function parseErrorPayload(res: Response): Promise<{
  message: string;
  code?: string;
}> {
  const fallback = `Request failed (${res.status})`;
  try {
    const data = (await res.json()) as ErrorPayload;
    return {
      message: typeof data.error === 'string' ? data.error : fallback,
      code: typeof data.code === 'string' ? data.code : undefined,
    };
  } catch {
    return { message: fallback };
  }
}

async function fetchWithDeadline(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  callerSignal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      if (callerSignal?.aborted) throw new Error('请求已取消');
      throw new Error('请求超时，请稍后重试');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}

export async function backendRequest<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {}
): Promise<T> {
  assertSafeBaseUrl();
  const withAuth = options.withAuth !== false;
  if (withAuth && options.authorizationToken) {
    throw new Error('authorizationToken requires withAuth=false');
  }
  if (
    withAuth &&
    options.expectedAuthEpoch !== undefined &&
    options.expectedAuthEpoch !== sessionEpoch
  ) {
    throw new AuthSessionChangedError();
  }
  const requestEpoch = withAuth ? sessionEpoch : null;
  if (
    options.idempotencyKey &&
    !/^[A-Za-z0-9._~-]{16,128}$/.test(options.idempotencyKey)
  ) {
    throw new Error('Invalid idempotency key');
  }
  const url = `${BASE}${path.startsWith('/') ? path : `/${path}`}`;

  const buildHeaders = async (): Promise<Record<string, string>> => {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Client-Version': CLIENT_VERSION,
      'X-Client-Platform': CLIENT_PLATFORM,
      'X-Client-Build': CLIENT_BUILD,
    };
    if (options.idempotencyKey) {
      h['Idempotency-Key'] = options.idempotencyKey;
    }
    if (withAuth) {
      const token = await getAccessToken();
      if (requestEpoch !== sessionEpoch) throw new AuthSessionChangedError();
      if (token) h['Authorization'] = `Bearer ${token}`;
    } else if (options.authorizationToken) {
      h['Authorization'] = `Bearer ${options.authorizationToken}`;
    }
    return h;
  };

  const doFetch = async (): Promise<Response> => {
    try {
      return await fetchWithDeadline(
        url,
        {
          method,
          headers: await buildHeaders(),
          body: body !== undefined ? JSON.stringify(body) : undefined,
        },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        options.signal
      );
    } catch (error) {
      if (error instanceof AuthSessionChangedError) throw error;
      if (error instanceof Error && /超时|取消/.test(error.message)) throw error;
      throw new Error('网络连接失败，请检查网络后重试');
    }
  };

  let res = await doFetch();
  if (requestEpoch !== null && requestEpoch !== sessionEpoch) {
    throw new AuthSessionChangedError();
  }

  // 401 → try one refresh + retry. If refresh fails, wipe local tokens
  // and throw UnauthorizedError so the AuthProvider can route back
  // to the welcome screen.
  if (res.status === 401 && withAuth && options.autoRefresh !== false) {
    if (requestEpoch === null) throw new UnauthorizedError();
    const initialError = await parseErrorPayload(res);
    // Provider authentication failures must be mapped to 502/503 by the
    // backend. The explicit code is nevertheless required before refreshing
    // so a future upstream regression cannot sign users out again.
    if (initialError.code !== AUTH_EXPIRED_CODE) {
      throw new BackendError(initialError.message, res.status, initialError.code);
    }

    const refreshResult = await tryRefresh(requestEpoch);
    if (refreshResult === 'refreshed') {
      res = await doFetch();
      if (requestEpoch !== sessionEpoch) {
        throw new AuthSessionChangedError();
      }
    }
    if (refreshResult === 'unavailable') {
      throw new BackendError(
        '暂时无法验证登录状态，请稍后重试',
        503,
        'AUTH_REFRESH_UNAVAILABLE'
      );
    }
    if (refreshResult === 'stale') throw new AuthSessionChangedError();
    if (refreshResult === 'invalid' || res.status === 401) {
      if (requestEpoch !== sessionEpoch) {
        throw new AuthSessionChangedError();
      }
      await clearSessionTokens().catch(() => {});
      notifyAuthExpired();
      throw new UnauthorizedError();
    }
  }

  if (!res.ok) {
    const payload = await parseErrorPayload(res);
    if (requestEpoch !== null && requestEpoch !== sessionEpoch) {
      throw new AuthSessionChangedError();
    }
    throw new BackendError(payload.message, res.status, payload.code);
  }

  // Empty 204s exist (logout) — don't blow up trying to parse JSON.
  if (res.status === 204) {
    if (requestEpoch !== null && requestEpoch !== sessionEpoch) {
      throw new AuthSessionChangedError();
    }
    return undefined as T;
  }
  try {
    const data = (await res.json()) as T;
    if (requestEpoch !== null && requestEpoch !== sessionEpoch) {
      throw new AuthSessionChangedError();
    }
    return data;
  } catch {
    if (requestEpoch !== null && requestEpoch !== sessionEpoch) {
      throw new AuthSessionChangedError();
    }
    throw new Error(`服务器响应格式错误 (${res.status})`);
  }
}

type RefreshResult = 'refreshed' | 'invalid' | 'unavailable' | 'stale';
let refreshAttempt: {
  epoch: number;
  promise: Promise<RefreshResult>;
} | null = null;

function tryRefresh(expectedEpoch: number): Promise<RefreshResult> {
  if (refreshAttempt?.epoch === expectedEpoch) return refreshAttempt.promise;
  // Register before the first await so simultaneous 401 handlers cannot both
  // rotate the same one-use refresh token and trigger family replay defence.
  const promise = refreshForEpoch(expectedEpoch).finally(() => {
    if (refreshAttempt?.promise === promise) refreshAttempt = null;
  });
  refreshAttempt = { epoch: expectedEpoch, promise };
  return promise;
}

async function refreshForEpoch(
  expectedEpoch: number
): Promise<RefreshResult> {
  const refreshToken = await getRefreshToken();
  if (sessionEpoch !== expectedEpoch) return 'stale';
  if (!refreshToken) return 'invalid';
  return performRefresh(expectedEpoch, refreshToken);
}

async function performRefresh(
  expectedEpoch: number,
  refreshToken: string
): Promise<RefreshResult> {
  try {
    const idempotencyKey = await prepareRefreshIdempotencyKey(
      expectedEpoch,
      refreshToken
    );
    if (sessionEpoch !== expectedEpoch) return 'stale';
    if (!idempotencyKey) return 'unavailable';
    const res = await fetchWithDeadline(
      `${BASE}/auth/refresh`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Version': CLIENT_VERSION,
          'X-Client-Platform': CLIENT_PLATFORM,
          'X-Client-Build': CLIENT_BUILD,
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
      },
      12_000
    );
    if (sessionEpoch !== expectedEpoch) return 'stale';
    if (res.status === 401 || res.status === 403) return 'invalid';
    if (!res.ok) return 'unavailable';
    const data = (await res.json()) as {
      access_token?: unknown;
      refresh_token?: unknown;
    };
    if (typeof data.access_token !== 'string') return 'unavailable';
    const nextRefresh =
      typeof data.refresh_token === 'string'
        ? data.refresh_token
        : refreshToken;
    return (await commitRefreshedSession(
      expectedEpoch,
      refreshToken,
      data.access_token,
      nextRefresh
    ))
      ? 'refreshed'
      : 'stale';
  } catch {
    return sessionEpoch === expectedEpoch ? 'unavailable' : 'stale';
  }
}

async function commitRefreshedSession(
  expectedEpoch: number,
  expectedRefresh: string,
  access: string,
  refresh: string
): Promise<boolean> {
  return runTokenMutation(async () => {
    if (
      sessionEpoch !== expectedEpoch ||
      cachedRefresh !== expectedRefresh
    ) {
      return false;
    }
    await SecureStore.setItemAsync(
      SESSION_KEY,
      serializeStoredSession(access, refresh)
    );
    if (sessionEpoch !== expectedEpoch) return false;
    cachedAccess = access;
    cachedRefresh = refresh;
    cachedRefreshIdempotencyKey = null;
    return true;
  });
}

/**
 * Persist the retry identity before the one-time token leaves the device.
 * If the server rotates successfully but the response is lost (or the app is
 * killed before commit), the next process reuses this exact key and receives
 * the original rotation result instead of triggering family-reuse defence.
 */
async function prepareRefreshIdempotencyKey(
  expectedEpoch: number,
  expectedRefresh: string
): Promise<string | null> {
  return runTokenMutation(async () => {
    if (
      sessionEpoch !== expectedEpoch ||
      cachedRefresh !== expectedRefresh ||
      !cachedAccess
    ) {
      return null;
    }
    if (cachedRefreshIdempotencyKey) {
      return cachedRefreshIdempotencyKey;
    }

    const idempotencyKey = randomUUID();
    await SecureStore.setItemAsync(
      SESSION_KEY,
      serializeStoredSession(
        cachedAccess,
        expectedRefresh,
        idempotencyKey
      )
    );
    if (
      sessionEpoch !== expectedEpoch ||
      cachedRefresh !== expectedRefresh
    ) {
      return null;
    }
    cachedRefreshIdempotencyKey = idempotencyKey;
    return idempotencyKey;
  });
}

function serializeStoredSession(
  access: string,
  refresh: string,
  refreshIdempotencyKey?: string
): string {
  return JSON.stringify({
    version: 2,
    state: 'active',
    access_token: access,
    refresh_token: refresh,
    ...(refreshIdempotencyKey
      ? { refresh_idempotency_key: refreshIdempotencyKey }
      : {}),
  } satisfies StoredSession);
}

function isRefreshIdempotencyKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 16 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._~-]+$/.test(value)
  );
}
