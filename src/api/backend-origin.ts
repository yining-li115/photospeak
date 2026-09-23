/** The only backend origin shipped in production builds. */
export const PRODUCTION_API_BASE = 'https://api.dailyphotospeak.cn';

interface BackendOriginOptions {
  isDev: boolean;
  developmentOverride?: string;
}

function normalizeBaseUrl(value: string | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '');
}

/**
 * Production must not depend on a developer machine's environment. Local
 * HTTP endpoints remain available to Expo development builds only.
 */
export function resolveBackendBaseUrl({
  isDev,
  developmentOverride,
}: BackendOriginOptions): string {
  if (isDev) {
    const override = normalizeBaseUrl(developmentOverride);
    if (override) return override;
  }

  return PRODUCTION_API_BASE;
}
