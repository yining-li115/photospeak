/**
 * Shared config for talking to our own backend (the Node/Hono proxy on
 * Aliyun). All API clients (mimo / mimo-tts / aliyun-asr) should call the
 * proxy instead of upstream MiMo / DashScope so the upstream API keys
 * never ship inside the mobile bundle.
 */

const BASE = process.env.EXPO_PUBLIC_API_BASE;
const TOKEN = process.env.EXPO_PUBLIC_API_TOKEN;

export class BackendNotConfiguredError extends Error {
  constructor() {
    super(
      'EXPO_PUBLIC_API_BASE / EXPO_PUBLIC_API_TOKEN are not set. Add them to your .env file.'
    );
    this.name = 'BackendNotConfiguredError';
  }
}

/** Throws if env is missing — call this at the start of every request. */
export function requireBackendConfig(): { base: string; token: string } {
  if (!BASE || !TOKEN) {
    throw new BackendNotConfiguredError();
  }
  return { base: BASE.replace(/\/$/, ''), token: TOKEN };
}

/** Standard headers for proxy requests (auth + JSON content type). */
export function backendHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}
