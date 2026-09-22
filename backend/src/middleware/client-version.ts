import type { MiddlewareHandler } from 'hono';

export interface ClientVersionPolicy {
  iosMinimumBuild?: number;
  androidMinimumBuild?: number;
}

/**
 * Reject pre-migration mobile binaries before they reach auth or business
 * routes. Build numbers are platform-local monotonic integers; semantic app
 * versions are intentionally not compared here.
 */
export function requireSupportedClient(
  policy: ClientVersionPolicy
): MiddlewareHandler {
  const minimums = {
    ios: normalizeMinimum(policy.iosMinimumBuild),
    android: normalizeMinimum(policy.androidMinimumBuild),
  } as const;
  const policyEnabled = minimums.ios > 0 || minimums.android > 0;

  return async (c, next) => {
    const platform = c.req.header('x-client-platform')?.toLowerCase();
    const minimum =
      platform === 'ios'
        ? minimums.ios
        : platform === 'android'
          ? minimums.android
          : Math.max(minimums.ios, minimums.android);
    if (!policyEnabled || minimum === 0) {
      await next();
      return;
    }

    const rawBuild = c.req.header('x-client-build');
    const build = Number(rawBuild);
    if (!Number.isSafeInteger(build) || build < minimum) {
      return c.json(
        {
          error: '请更新到最新版本后继续使用',
          code: 'APP_UPDATE_REQUIRED',
          minimum_build: minimum,
          platform,
        },
        426
      );
    }
    await next();
  };
}

function normalizeMinimum(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : 0;
}
