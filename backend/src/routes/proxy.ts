/**
 * /api/* — proxied calls to MiMo (analyze + tts).
 *
 * Each route is gated by:
 *   1. requireAuth (JWT or legacy APP_SHARED_TOKEN — see S1)
 *   2. bodyLimit  (per-route hard cap, first line of defence against
 *      gigantic payloads exhausting memory)
 *   3. zValidator (zod schema, ensures the forwarded body has the exact
 *      shape we expect — model is locked to the value our client sends,
 *      so attackers can't swap in arbitrary chat-completions calls and
 *      turn this proxy into a generic OpenAI passthrough)
 *
 * STT lives in its own router (`routes/transcribe.ts`) — clients call
 * `POST /api/transcribe/token` to get a short-lived DashScope
 * credential, then stream audio directly to DashScope over
 * WebSocket. Audio bytes never transit this process.
 *
 * This is the legacy "thin proxy" architecture and is slated to grow
 * into a proper LLM Gateway with multi-provider routing, cost
 * tracking, and circuit breakers (P14). When that happens these route
 * handlers should call into the gateway abstraction rather than
 * `fetch` directly.
 */
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { requireAuth, type AuthVars } from '../auth/middleware.js';
import { clientIp, rateLimit } from '../middleware/rate-limit.js';

const MIMO_BASE = 'https://api.xiaomimimo.com/v1';

// ─── schemas ──────────────────────────────────────────────────────
//
// Notes on bounds:
//   - 10MB string cap on image_url.url matches the 5MB analyze body
//     limit (base64 inflates ~33%).
//   - max_completion_tokens is capped at 32k — well above what our
//     client ever requests (12288), but well below MiMo's max so we
//     can't be tricked into very expensive single calls.
//   - Unknown fields are silently stripped (zod's default), so even
//     if a client tries to inject `tools`, `stream`, etc. the proxy
//     forwards a clean body.

const analyzeContentItemSchema = z.union([
  z.object({
    type: z.literal('image_url'),
    image_url: z.object({ url: z.string().max(10_000_000) }),
  }),
  z.object({
    type: z.literal('text'),
    text: z.string().max(50_000),
  }),
]);

const analyzeMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.union([
    z.string().max(50_000),
    z.array(analyzeContentItemSchema).min(1).max(8),
  ]),
});

const analyzeSchema = z.object({
  model: z.literal('mimo-v2.5'),
  messages: z.array(analyzeMessageSchema).min(1).max(50),
  max_completion_tokens: z.number().int().positive().max(32_768).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

const ttsSchema = z.object({
  model: z.literal('mimo-v2.5-tts'),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(2000),
      })
    )
    .min(1)
    .max(4),
  audio: z.object({
    format: z.enum(['wav', 'mp3', 'pcm16']),
    voice: z.string().min(1).max(64),
  }),
});

// ─── helpers ──────────────────────────────────────────────────────

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

// ─── router ───────────────────────────────────────────────────────

export interface ProxyEnv {
  MIMO_API_KEY: string;
  /** Legacy shared bearer — passed through to requireAuth so old
   *  IPA/APK builds keep working. Sunset path tracked in S1. */
  APP_SHARED_TOKEN?: string;
}

export function createProxyRouter(env: ProxyEnv) {
  const router = new Hono<{ Variables: AuthVars }>();

  router.use('*', requireAuth(env.APP_SHARED_TOKEN));

  // Per-user (or per-IP for legacy shared-token clients) rate limit
  // across all /api/* routes. 30/min covers normal usage with comfort
  // margin (a real user generates < 5/min during an active session).
  // Daily quotas / cost ceilings live in P16 once Redis is around.
  router.use(
    '*',
    rateLimit({
      name: 'api-user',
      windowMs: 60_000,
      max: 30,
      keyFn: (c) => {
        const userId = c.get('userId');
        return userId ? `user:${userId}` : `ip:${clientIp(c)}`;
      },
    })
  );

  router.post(
    '/analyze',
    bodyLimit({ maxSize: 5 * 1024 * 1024 }),
    zValidator('json', analyzeSchema),
    async (c) => {
      const body = c.req.valid('json');
      const upstream = await fetch(`${MIMO_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': env.MIMO_API_KEY,
        },
        body: JSON.stringify(body),
      });
      return passthrough(upstream);
    }
  );

  router.post(
    '/tts',
    bodyLimit({ maxSize: 64 * 1024 }),
    zValidator('json', ttsSchema),
    async (c) => {
      const body = c.req.valid('json');
      const upstream = await fetch(`${MIMO_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': env.MIMO_API_KEY,
        },
        body: JSON.stringify(body),
      });
      return passthrough(upstream);
    }
  );

  return router;
}
