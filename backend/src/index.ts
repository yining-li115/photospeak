import { Hono } from 'hono';
import { cors } from 'hono/cors';

interface Env {
  /** MiMo API key — used for image+text analysis and TTS. */
  MIMO_API_KEY: string;
  /** Aliyun DashScope key — used for qwen3-asr-flash STT. */
  DASHSCOPE_API_KEY: string;
  /** Shared secret the mobile app sends in Authorization. Generate
   *  a long random string and put it in both .dev.vars and the
   *  mobile app's .env (EXPO_PUBLIC_API_TOKEN). Until we add real
   *  per-user auth this is just a "you-are-the-app" check. */
  APP_SHARED_TOKEN: string;
}

const MIMO_BASE = 'https://api.xiaomimimo.com/v1';
const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/api/v1';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

// Public liveness check — no auth, useful for "is the worker up?".
app.get('/', (c) => c.text('PhotoSpeak API · ok'));
app.get('/health', (c) =>
  c.json({ status: 'ok', deployedAt: new Date().toISOString() })
);

// Everything under /api needs the shared token. Mobile sends:
//   Authorization: Bearer <APP_SHARED_TOKEN>
app.use('/api/*', async (c, next) => {
  const auth = c.req.header('authorization') ?? '';
  const expected = `Bearer ${c.env.APP_SHARED_TOKEN}`;
  if (!c.env.APP_SHARED_TOKEN || auth !== expected) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});

/**
 * STT — Aliyun DashScope qwen3-asr-flash.
 * Body forwarded as-is to:
 *   POST /services/aigc/multimodal-generation/generation
 * Mobile already builds the right body shape (model, input.messages
 * with audio data URI, asr_options); we just inject the key.
 */
app.post('/api/transcribe', async (c) => {
  const body = await c.req.text();
  const upstream = await fetch(
    `${DASHSCOPE_BASE}/services/aigc/multimodal-generation/generation`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${c.env.DASHSCOPE_API_KEY}`,
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
      'api-key': c.env.MIMO_API_KEY,
    },
    body,
  });
  return passthrough(upstream);
});

/**
 * TTS — same MiMo chat-completions endpoint with the TTS model
 * (mimo-v2.5-tts) and an `audio` field. Response carries base64
 * audio in choices[0].message.audio.data; we just relay JSON back.
 */
app.post('/api/tts', async (c) => {
  const body = await c.req.text();
  const upstream = await fetch(`${MIMO_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': c.env.MIMO_API_KEY,
    },
    body,
  });
  return passthrough(upstream);
});

/** Forward upstream's status + body without buffering JSON parse —
 *  errors from MiMo / DashScope keep their original shape. */
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

export default app;
