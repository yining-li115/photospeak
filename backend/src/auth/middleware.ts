import type { Context, MiddlewareHandler } from 'hono';
import { verifyToken } from './jwt.js';

/**
 * Hono variables set by `requireAuth` so handlers can read the
 * authenticated user id without re-decoding the token.
 */
export type AuthVars = {
  userId: string;
  /** True when the request used the legacy APP_SHARED_TOKEN bearer
   *  instead of a per-user JWT. Lets us reject deprecated paths
   *  (like /auth/me) when no real user is identified. */
  isLegacyToken: boolean;
};

/**
 * Emit one structured JSON line per authed request so we can grep PM2
 * logs for legacy-vs-jwt traffic mix. Drives the S1 sunset decision —
 * once legacy traffic decays below threshold, the legacy branch in
 * `requireAuth` can be removed.
 */
function logAuth(
  c: Context,
  mode: 'jwt' | 'legacy',
  userId: string
): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'auth',
      path: c.req.path,
      method: c.req.method,
      mode,
      userId,
      clientVersion: c.req.header('x-client-version') || '',
      clientPlatform: c.req.header('x-client-platform') || '',
      userAgent: (c.req.header('user-agent') || '').slice(0, 120),
      ip:
        c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
        c.req.header('x-real-ip') ||
        '',
    })
  );
}

/**
 * Standard auth gate for /api/*. Accepts:
 *   1. A per-user JWT issued by /auth/* (the long-term path)
 *   2. The legacy APP_SHARED_TOKEN bearer (kept until every shipped
 *      mobile build has been replaced; remove once all clients use JWT).
 */
export function requireAuth(legacySharedToken?: string): MiddlewareHandler<{
  Variables: AuthVars;
}> {
  return async (c, next) => {
    const header = c.req.header('authorization');
    if (!header || !header.startsWith('Bearer ')) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const token = header.slice(7);

    if (legacySharedToken && token === legacySharedToken) {
      c.set('userId', '');
      c.set('isLegacyToken', true);
      logAuth(c, 'legacy', '');
      await next();
      return;
    }

    try {
      const payload = verifyToken(token, 'access');
      c.set('userId', payload.sub);
      c.set('isLegacyToken', false);
      logAuth(c, 'jwt', payload.sub);
      await next();
    } catch {
      return c.json({ error: 'unauthorized' }, 401);
    }
  };
}

/**
 * Stricter variant for endpoints that need a real identified user
 * (no legacy shared token). Use this for /auth/me, /auth/logout, and
 * anything that writes per-user data.
 */
export function requireUser(): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    const header = c.req.header('authorization');
    if (!header || !header.startsWith('Bearer ')) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const token = header.slice(7);
    try {
      const payload = verifyToken(token, 'access');
      c.set('userId', payload.sub);
      c.set('isLegacyToken', false);
      logAuth(c, 'jwt', payload.sub);
      await next();
    } catch {
      return c.json({ error: 'unauthorized' }, 401);
    }
  };
}
