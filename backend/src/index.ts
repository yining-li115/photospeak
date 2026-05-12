import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { type AuthVars } from './auth/middleware.js';
import { privacyHtml } from './legal.js';
import { createAuthRouter } from './routes/auth.js';
import { createProxyRouter } from './routes/proxy.js';
import { createTranscribeRouter } from './routes/transcribe.js';

interface Env {
  MIMO_API_KEY: string;
  DASHSCOPE_API_KEY: string;
  /** Legacy shared bearer (will be removed once every shipped mobile
   *  build authenticates with a real JWT). Optional now — set this
   *  while older builds are still in users' hands. */
  APP_SHARED_TOKEN?: string;
  /** iOS bundle identifier — used as the `aud` claim when verifying
   *  Apple identity tokens. Must match `ios.bundleIdentifier` in
   *  app.json. */
  APPLE_BUNDLE_ID: string;
  PHONE_LOGIN_ENABLED: boolean;
}

function readEnv(): Env {
  const e = process.env;
  for (const k of [
    'MIMO_API_KEY',
    'DASHSCOPE_API_KEY',
    'APPLE_BUNDLE_ID',
    'JWT_SECRET',
    'DATABASE_URL',
  ]) {
    if (!e[k]) throw new Error(`Missing required env var: ${k}`);
  }
  return {
    MIMO_API_KEY: e.MIMO_API_KEY!,
    DASHSCOPE_API_KEY: e.DASHSCOPE_API_KEY!,
    APP_SHARED_TOKEN: e.APP_SHARED_TOKEN || undefined,
    APPLE_BUNDLE_ID: e.APPLE_BUNDLE_ID!,
    PHONE_LOGIN_ENABLED: e.PHONE_LOGIN_ENABLED === 'true',
  };
}

const env = readEnv();
const app = new Hono<{ Variables: AuthVars }>();

// No CORS middleware on purpose. The only client today is React
// Native, whose fetch doesn't enforce same-origin policy, and the
// public HTML pages (/privacy, /terms) are reached via direct
// browser navigation rather than cross-origin XHR. If a Web client
// (see optimization.md Q6) materializes, add `cors({ origin: [...] })`
// here scoped to known frontend origins — never wildcard.
//
// Public liveness checks.
app.get('/', (c) => c.text('PhotoSpeak API · ok'));
app.get('/health', (c) =>
  c.json({ status: 'ok', deployedAt: new Date().toISOString() })
);

// Public legal page — App Store Connect submission requires a real,
// reachable URL for the privacy policy. /privacy and /terms both
// resolve to the same combined doc for now (terms section is part of
// the privacy page); split them into separate handlers if Apple's
// review ever asks for it.
app.get('/privacy', (c) => c.html(privacyHtml()));
app.get('/terms', (c) => c.html(privacyHtml()));

// /auth/* — public (login flows don't need auth themselves; logout/me
// have their own requireUser middleware).
app.route(
  '/auth',
  createAuthRouter({
    appleBundleId: env.APPLE_BUNDLE_ID,
    phoneLoginEnabled: env.PHONE_LOGIN_ENABLED,
  })
);

// /api/transcribe/* — STT token issuance. Mounted before the broader
// /api/* router so its stricter `requireUser` gate (no legacy
// shared-token fallback) takes precedence. Audio bytes never reach
// this process; the client opens a WebSocket directly to DashScope
// using the short-lived token returned here.
app.route(
  '/api/transcribe',
  createTranscribeRouter({
    DASHSCOPE_API_KEY: env.DASHSCOPE_API_KEY,
  })
);

// /api/* — proxied calls to MiMo (analyze + tts). Auth + body
// validation + per-route size limits live inside the router (see
// routes/proxy.ts).
app.route(
  '/api',
  createProxyRouter({
    MIMO_API_KEY: env.MIMO_API_KEY,
    APP_SHARED_TOKEN: env.APP_SHARED_TOKEN,
  })
);

// Catch unhandled errors thrown from route handlers.
// HTTPException (e.g. zValidator failures) keeps its original 4xx
// response. Everything else is a real internal error — log a
// structured line and return a generic 500 (don't leak internals).
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'error',
      path: c.req.path,
      method: c.req.method,
      userId: c.get('userId') || '',
      message: err.message,
      stack: (err.stack || '').slice(0, 2000),
    })
  );
  return c.json({ error: 'internal server error' }, 500);
});

// Process-level guards. We deliberately do NOT swallow these — the
// process state may be corrupted, so we log and exit. PM2 restarts.
process.on('uncaughtException', (err) => {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'fatal',
      kind: 'uncaughtException',
      message: err.message,
      stack: (err.stack || '').slice(0, 2000),
    })
  );
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : null;
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'fatal',
      kind: 'unhandledRejection',
      message: err ? err.message : String(reason),
      stack: err ? (err.stack || '').slice(0, 2000) : '',
    })
  );
  process.exit(1);
});

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`[photospeak-api] listening on :${port}`);
