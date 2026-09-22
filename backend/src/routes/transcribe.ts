/**
 * /api/transcribe/session issues a one-use ticket for PhotoSpeak's own
 * constrained WebSocket relay. Provider credentials never leave the backend,
 * and the relay itself fixes the model, task type, audio format, duration and
 * byte budget server-side.
 */
import { Hono } from 'hono';
import { requireUser, type AuthVars } from '../auth/middleware.js';
import { rateLimit } from '../middleware/rate-limit.js';
import {
  issueTranscriptionTicket,
  TRANSCRIBE_WS_PATH,
} from '../transcription/relay.js';

export interface TranscribeEnv {
  dailySafetyLimit?: number;
}

export function createTranscribeRouter(env: TranscribeEnv) {
  const router = new Hono<{ Variables: AuthVars }>();

  router.use('*', requireUser());
  router.use(
    '*',
    rateLimit({
      name: 'transcribe-session',
      windowMs: 60_000,
      max: 5,
      keyFn: (c) => `user:${c.get('userId')}`,
      code: 'TRANSCRIBE_RATE_LIMITED',
    }),
    rateLimit({
      name: 'transcribe-session-daily-safety',
      windowMs: 24 * 60 * 60 * 1000,
      max: env.dailySafetyLimit ?? 100,
      softLimit: Math.floor((env.dailySafetyLimit ?? 100) * 0.8),
      keyFn: (c) => `user:${c.get('userId')}`,
      message: '今日录音启动次数异常频繁，请稍后再试',
      code: 'USAGE_SAFETY_LIMIT',
    })
  );

  router.post('/session', (c) => {
    const issued = issueTranscriptionTicket(c.get('userId'), c.get('plan'));
    return c.json({
      ticket: issued.ticket,
      expires_at: Math.floor(issued.expiresAt / 1000),
      ws_path: TRANSCRIBE_WS_PATH,
      session_id: issued.sessionId,
    });
  });

  return router;
}
