import type { Context, MiddlewareHandler } from 'hono';

const active = new Map<string, number>();

export interface ConcurrencyLimitOptions {
  max: number;
  keyFn: (c: Context) => string;
}

/**
 * Single-process concurrency guard. It is intentionally a middleware so its
 * storage can later be replaced with a Redis lease without changing routes.
 */
export function concurrencyLimit(
  options: ConcurrencyLimitOptions
): MiddlewareHandler {
  return async (c, next) => {
    const key = options.keyFn(c);
    const count = active.get(key) ?? 0;
    if (count >= options.max) {
      c.header('Retry-After', '2');
      return c.json(
        {
          error: '已有请求正在处理中，请稍候',
          code: 'REQUEST_IN_PROGRESS',
        },
        429
      );
    }

    active.set(key, count + 1);
    try {
      await next();
    } finally {
      const remaining = (active.get(key) ?? 1) - 1;
      if (remaining <= 0) active.delete(key);
      else active.set(key, remaining);
    }
  };
}
