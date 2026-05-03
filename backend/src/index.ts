import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

const MIMO_BASE = 'https://api.xiaomimimo.com/v1';
const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/api/v1';

interface Env {
  MIMO_API_KEY: string;
  DASHSCOPE_API_KEY: string;
  /** Shared secret the mobile app sends in Authorization. Generate
   *  a long random string and put it in both .env and the mobile
   *  app's .env (EXPO_PUBLIC_API_TOKEN). Until we add real per-user
   *  auth this is just a "you-are-the-app" check. */
  APP_SHARED_TOKEN: string;
}

function readEnv(): Env {
  const e = process.env;
  const required = ['MIMO_API_KEY', 'DASHSCOPE_API_KEY', 'APP_SHARED_TOKEN'];
  for (const k of required) {
    if (!e[k]) {
      throw new Error(`Missing required env var: ${k}`);
    }
  }
  return {
    MIMO_API_KEY: e.MIMO_API_KEY!,
    DASHSCOPE_API_KEY: e.DASHSCOPE_API_KEY!,
    APP_SHARED_TOKEN: e.APP_SHARED_TOKEN!,
  };
}

const env = readEnv();
const app = new Hono();

app.use('*', cors());

// Public liveness checks — no auth, useful for load balancer / monitor.
app.get('/', (c) => c.text('PhotoSpeak API · ok'));
app.get('/health', (c) =>
  c.json({ status: 'ok', deployedAt: new Date().toISOString() })
);

// /api/* requires Bearer token equal to APP_SHARED_TOKEN.
app.use('/api/*', async (c, next) => {
  const auth = c.req.header('authorization') ?? '';
  if (auth !== `Bearer ${env.APP_SHARED_TOKEN}`) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});

/**
 * STT — Aliyun DashScope qwen3-asr-flash.
 * Mobile app builds the body (model/input.messages with audio data
 * URI/asr_options); we just inject the upstream key.
 */
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

/**
 * Image+text analysis OR follow-up chat — MiMo chat completions.
 * Mobile sends the full chat-completions body (model: mimo-v2.5,
 * messages with image_url + text, etc).
 */
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

/**
 * TTS — same MiMo chat-completions endpoint with the TTS model
 * (mimo-v2.5-tts) and an `audio` field. Response carries base64
 * audio in choices[0].message.audio.data; we just relay JSON.
 */
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
