import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createAuthRouter } from './routes/auth.js';
import { requireAuth, type AuthVars } from './auth/middleware.js';
import { privacyHtml } from './legal.js';

const MIMO_BASE = 'https://api.xiaomimimo.com/v1';
const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/api/v1';

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

app.use('*', cors());

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

// /api/* — proxied calls to MiMo / DashScope. Accepts either a
// per-user JWT or the legacy APP_SHARED_TOKEN bearer (until every
// shipped mobile build has been replaced).
app.use('/api/*', requireAuth(env.APP_SHARED_TOKEN));

app.post('/api/transcribe', async (c) => {
  const body = await c.req.text();
  const upstream = await fetch(
    `${DASHSCOPE_BASE}/services/aigc/multimodal-generation/generation`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.DASHSCOPE_API_KEY}`,
      },
      body,
    }
  );
  return passthrough(upstream);
});

app.post('/api/analyze', async (c) => {
  const body = await c.req.text();
  const upstream = await fetch(`${MIMO_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': env.MIMO_API_KEY,
    },
    body,
  });
  return passthrough(upstream);
});

app.post('/api/tts', async (c) => {
  const body = await c.req.text();
  const upstream = await fetch(`${MIMO_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': env.MIMO_API_KEY,
    },
    body,
  });
  return passthrough(upstream);
});

async function passthrough(res: Response): Promise<Response> {
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: {
      'Content-Type':
        res.headers.get('Content-Type') ?? 'application/json',
    },
  });
}

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`[photospeak-api] listening on :${port}`);
