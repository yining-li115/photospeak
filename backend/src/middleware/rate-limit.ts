/**
 * In-memory fixed-window rate limiter.
 *
 * Why in-memory:
 *   - Single Node process today (PM2 cluster mode is P9). Migrating
 *     to Redis is part of P2 — at that point swap the `stores` Map
 *     for a Redis-backed implementation but keep the public surface.
 *   - Avoids adding a Redis dependency before we actually need one.
 *
 * Limits / memory:
 *   - Each bucket is its own Map, so different routes don't collide.
 *   - Lazy cleanup: every named bucket is swept at most once per
 *     SWEEP_INTERVAL_MS to drop expired entries.
 *
 * Two surfaces:
 *   - `rateLimit(...)` middleware — for keys derivable without
 *     parsing the body (e.g. IP, userId).
 *   - `rateLimitConsume(...)` pure function — for keys derived from
 *     the body (e.g. phone number), called inline from the handler
 *     after body parsing.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

interface Bucket {
  count: number;
  resetAt: number; // epoch ms
}

const stores = new Map<string, Map<string, Bucket>>();
const lastSweep = new Map<string, number>();
const SWEEP_INTERVAL_MS = 60_000;

function getStore(name: string): Map<string, Bucket> {
  let store = stores.get(name);
  if (!store) {
    store = new Map();
    stores.set(name, store);
  }
  return store;
}

function maybeSweep(name: string, store: Map<string, Bucket>, now: number): void {
  const last = lastSweep.get(name) ?? 0;
  if (now - last < SWEEP_INTERVAL_MS) return;
  for (const [k, b] of store) {
    if (b.resetAt <= now) store.delete(k);
  }
  lastSweep.set(name, now);
}

export interface ConsumeResult {
  ok: boolean;
  retryAfterSec: number;
  count: number;
  max: number;
}

/**
 * Atomically increment the bucket for `key` in `name`. Returns
 * `{ ok: false, retryAfterSec }` once the count exceeds `max` within
 * the current window.
 */
export function rateLimitConsume(opts: {
  name: string;
  key: string;
  windowMs: number;
  max: number;
}): ConsumeResult {
  const store = getStore(opts.name);
  const now = Date.now();
  maybeSweep(opts.name, store, now);

  let bucket = store.get(opts.key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + opts.windowMs };
    store.set(opts.key, bucket);
  }
  bucket.count++;

  if (bucket.count > opts.max) {
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      count: bucket.count,
      max: opts.max,
    };
  }
  return { ok: true, retryAfterSec: 0, count: bucket.count, max: opts.max };
}

export interface RateLimitOptions {
  /** Bucket name — unique per route + scope. */
  name: string;
  windowMs: number;
  max: number | ((c: Context) => number | Promise<number>);
  /** Log when this many requests are reached without blocking the caller. */
  softLimit?: number | ((c: Context) => number | Promise<number>);
  /** Return the bucket key (user id, IP, phone, ...). Return null /
   *  empty to skip the limit (e.g. when the caller is unidentifiable). */
  keyFn: (c: Context) => string | null | undefined | Promise<string | null | undefined>;
  /** Override the 429 message; defaults to a generic Chinese string. */
  message?: string;
  /** Stable machine-readable error code for clients. */
  code?: string;
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  return async (c, next) => {
    const key = await opts.keyFn(c);
    if (!key) {
      await next();
      return;
    }
    const result = rateLimitConsume({
      name: opts.name,
      key,
      windowMs: opts.windowMs,
      max:
        typeof opts.max === 'function' ? await opts.max(c) : opts.max,
    });
    const softLimit =
      typeof opts.softLimit === 'function'
        ? await opts.softLimit(c)
        : opts.softLimit;
    if (softLimit && result.count === softLimit) {
      console.warn(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: 'rate_limit.soft_threshold',
          bucket: opts.name,
          key,
          count: result.count,
          hardLimit: result.max,
        })
      );
    }
    if (!result.ok) {
      c.header('Retry-After', String(result.retryAfterSec));
      return c.json(
        {
          error: opts.message ?? '请求过于频繁，请稍后再试',
          ...(opts.code ? { code: opts.code } : {}),
        },
        429
      );
    }
    await next();
  };
}

/**
 * Best-effort client IP. Forwarding headers are attacker-controlled unless
 * the Node process is reachable only through a trusted reverse proxy, so they
 * are ignored by default. Set TRUST_PROXY=true only with that network setup.
 */
export function clientIp(
  c: Context,
  options: { trustProxy?: boolean } = {}
): string {
  if (options.trustProxy) {
    // PhotoSpeak currently supports exactly one trusted edge proxy. Read the
    // right-most hop: with nginx's common append behaviour, any client-spoofed
    // values stay to the left while the proxy-observed peer is appended last.
    // Multi-hop/CDN deployments must normalize the header at the edge or move
    // this policy to an explicit trusted-hop count.
    const forwardedParts = c.req.header('x-forwarded-for')
      ?.split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    const forwarded = forwardedParts?.[forwardedParts.length - 1];
    if (forwarded) return forwarded;
    const real = c.req.header('x-real-ip');
    if (real) return real;
  }
  try {
    return getConnInfo(c).remote.address || 'unknown';
  } catch {
    return 'unknown';
  }
}
