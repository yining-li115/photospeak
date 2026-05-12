/**
 * /api/transcribe/* — STT token issuance.
 *
 * Unlike the batch routes in proxy.ts, transcribe lives on its own
 * because it doesn't proxy audio bytes. Clients call
 * `POST /api/transcribe/token` to get a short-lived DashScope
 * credential, then open a WebSocket directly to DashScope's
 * paraformer-realtime-v2 service. The backend never sees the audio
 * stream.
 *
 * This is the same pattern as OpenAI Realtime ephemeral session
 * tokens, AssemblyAI temporary tokens, and Deepgram tokens — the
 * server holds the long-lived API key and signs short-lived
 * delegations for the client to use directly.
 *
 * Future: when the LLM Gateway (P14) materialises, the token
 * issuance + per-call accounting hook moves into it.
 */
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { requireUser, type AuthVars } from '../auth/middleware.js';
import { clientIp, rateLimit } from '../middleware/rate-limit.js';

const DASHSCOPE_TOKEN_URL = 'https://dashscope.aliyuncs.com/api/v1/tokens';
const DASHSCOPE_WS_URL =
  'wss://dashscope.aliyuncs.com/api-ws/v1/inference';

// 5 minutes is well above what a single recording needs (typical 60s,
// outliers <120s) plus enough slack for the client to handshake the
// WebSocket. DashScope's upper bound is 1800s — we deliberately stay
// far below it so a leaked token is useful for a short time only.
const TOKEN_TTL_SECONDS = 300;

interface DashScopeTokenResponse {
  token?: string;
  expires_at?: number;
}

export interface TranscribeEnv {
  DASHSCOPE_API_KEY: string;
}

export function createTranscribeRouter(env: TranscribeEnv) {
  const router = new Hono<{ Variables: AuthVars }>();

  // Strictly per-user — no legacy shared-token fallback for new paths.
  // Mobile builds that can't issue JWTs simply don't get streaming STT.
  router.use('*', requireUser());

  // Same shape as the /api/* limiter so users see consistent ceilings
  // whether they go through the batch proxy or the streaming token
  // endpoint. Daily quotas land in P16 once Redis is around.
  router.use(
    '*',
    rateLimit({
      name: 'transcribe-token',
      windowMs: 60_000,
      max: 30,
      keyFn: (c) => {
        const userId = c.get('userId');
        return userId ? `user:${userId}` : `ip:${clientIp(c)}`;
      },
    })
  );

  router.post('/token', async (c) => {
    const userId = c.get('userId');
    const sessionId = randomUUID();
    const requestedAt = Date.now();

    const upstream = await fetch(
      `${DASHSCOPE_TOKEN_URL}?expire_in_seconds=${TOKEN_TTL_SECONDS}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.DASHSCOPE_API_KEY}`,
        },
      }
    );

    if (!upstream.ok) {
      const bodyText = await upstream.text().catch(() => '');
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: 'transcribe.token.upstream_error',
          userId,
          sessionId,
          upstreamStatus: upstream.status,
          upstreamBody: bodyText.slice(0, 500),
          latencyMs: Date.now() - requestedAt,
        })
      );
      return c.json(
        { error: 'transcription service unavailable' },
        502
      );
    }

    let data: DashScopeTokenResponse;
    try {
      data = (await upstream.json()) as DashScopeTokenResponse;
    } catch {
      return c.json(
        { error: 'transcription service unavailable' },
        502
      );
    }

    if (typeof data.token !== 'string' || !data.token) {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: 'transcribe.token.missing',
          userId,
          sessionId,
          upstreamBody: JSON.stringify(data).slice(0, 500),
        })
      );
      return c.json(
        { error: 'transcription service unavailable' },
        502
      );
    }

    const expiresAt =
      typeof data.expires_at === 'number'
        ? data.expires_at
        : Math.floor(requestedAt / 1000) + TOKEN_TTL_SECONDS;

    // Hook point for cost / usage tracking (P19). One line per token
    // issued lets us count distinct recording attempts; the WS
    // session length is invisible from here but DashScope's own
    // billing covers that.
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'transcribe.token.issued',
        userId,
        sessionId,
        clientVersion: c.req.header('x-client-version') || '',
        clientPlatform: c.req.header('x-client-platform') || '',
        ttlSeconds: TOKEN_TTL_SECONDS,
        latencyMs: Date.now() - requestedAt,
      })
    );

    return c.json({
      token: data.token,
      expires_at: expiresAt,
      ws_url: DASHSCOPE_WS_URL,
      session_id: sessionId,
      // Lock the model server-side. Even though the client doesn't
      // pass this in run-task today, returning it here lets future
      // versions of the protocol (or a different STT provider) be
      // swapped without a client release.
      model: 'paraformer-realtime-v2',
    });
  });

  return router;
}
