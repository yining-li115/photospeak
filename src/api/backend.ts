/**
 * Shared HTTP client for talking to our backend (the Node/Hono proxy
 * + auth service on Aliyun). Owns:
 *
 *   1. Reading `EXPO_PUBLIC_API_BASE` from build-time env.
 *   2. SecureStore for access_token + refresh_token.
 *   3. Auto-refreshing on 401 and retrying the original request once.
 *   4. Standard JSON request/response framing.
 *
 * Call sites: auth.ts (login flows), mimo.ts / mimo-tts.ts /
 * aliyun-asr.ts (proxied API calls).
 */
import * as SecureStore from 'expo-secure-store';

const BASE = (process.env.EXPO_PUBLIC_API_BASE ?? '').replace(/\/$/, '');

const ACCESS_KEY = 'access_token';
const REFRESH_KEY = 'refresh_token';

export class BackendNotConfiguredError extends Error {
  constructor() {
    super(
      'EXPO_PUBLIC_API_BASE is not set. Add it to your .env file and rebuild.'
    );
    this.name = 'BackendNotConfiguredError';
  }
}

export class UnauthorizedError extends Error {
  constructor(message = '登录已过期，请重新登录') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

// ─── token storage ─────────────────────────────────────────────────

let cachedAccess: string | null = null;
let cachedRefresh: string | null = null;
let preloaded = false;

async function ensurePreloaded(): Promise<void> {
  if (preloaded) return;
  preloaded = true;
  try {
    cachedAccess = await SecureStore.getItemAsync(ACCESS_KEY);
    cachedRefresh = await SecureStore.getItemAsync(REFRESH_KEY);
  } catch {
    cachedAccess = null;
    cachedRefresh = null;
  }
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
  cachedAccess = access;
  cachedRefresh = refresh;
  preloaded = true;
  await SecureStore.setItemAsync(ACCESS_KEY, access);
  await SecureStore.setItemAsync(REFRESH_KEY, refresh);
}

export async function clearSessionTokens(): Promise<void> {
  cachedAccess = null;
  cachedRefresh = null;
  preloaded = true;
  await SecureStore.deleteItemAsync(ACCESS_KEY).catch(() => {});
  await SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => {});
}

// ─── request ───────────────────────────────────────────────────────

interface RequestOptions {
  /** Set false on /auth/apple, /auth/send-code, /auth/verify — those
   *  endpoints don't need (and shouldn't fail on) an access token. */
  withAuth?: boolean;
}

export async function backendRequest<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {}
): Promise<T> {
  if (!BASE) throw new BackendNotConfiguredError();
  const withAuth = options.withAuth !== false;
  const url = `${BASE}${path.startsWith('/') ? path : `/${path}`}`;

  const buildHeaders = async (): Promise<Record<string, string>> => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (withAuth) {
      const token = await getAccessToken();
      if (token) h['Authorization'] = `Bearer ${token}`;
    }
    return h;
  };

  const doFetch = async (): Promise<Response> => {
    try {
      return await fetch(url, {
        method,
        headers: await buildHeaders(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error('网络连接失败，请检查网络后重试');
    }
  };

  let res = await doFetch();

  // 401 → try one refresh + retry. If refresh fails, wipe local tokens
  // and throw UnauthorizedError so the AuthProvider can route back
  // to the welcome screen.
  if (res.status === 401 && withAuth) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      res = await doFetch();
    }
    if (res.status === 401) {
      await clearSessionTokens();
      throw new UnauthorizedError();
    }
  }

  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data && typeof data.error === 'string') msg = data.error;
    } catch {
      // non-JSON error body — keep the generic message.
    }
    const err = new Error(msg) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }

  // Empty 204s exist (logout) — don't blow up trying to parse JSON.
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`服务器响应格式错误 (${res.status})`);
  }
}

async function tryRefresh(): Promise<boolean> {
  const rt = await getRefreshToken();
  if (!rt) return false;
  try {
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { access_token?: unknown };
    if (typeof data.access_token !== 'string') return false;
    cachedAccess = data.access_token;
    await SecureStore.setItemAsync(ACCESS_KEY, data.access_token);
    return true;
  } catch {
    return false;
  }
}
