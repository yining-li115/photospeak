export interface DrainableServer {
  close(callback: (error?: Error) => void): unknown;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
}

export interface GracefulShutdownResult {
  forced: boolean;
  errors: string[];
}

/**
 * Stop accepting work, close WebSocket relays, and let in-flight HTTP work
 * finish before the database pool is closed. A hard timeout is deliberately
 * last-resort: forced shutdown is logged and returns a non-success result.
 */
export async function drainForShutdown(input: {
  server: DrainableServer;
  closeRelay: () => Promise<void>;
  closeDatabase: () => Promise<void>;
  timeoutMs?: number;
  log?: (record: Record<string, unknown>) => void;
}): Promise<GracefulShutdownResult> {
  const timeoutMs = Math.max(1, Math.floor(input.timeoutMs ?? 75_000));
  const log = input.log ?? (() => {});
  const errors: string[] = [];

  // `close` synchronously stops new TCP accepts, then invokes its callback
  // once existing HTTP requests/connections have drained.
  const httpDrained = new Promise<void>((resolve) => {
    input.server.close((error) => {
      if (error) errors.push(`http:${error.name}`);
      resolve();
    });
    input.server.closeIdleConnections?.();
  });
  const relayDrained = input.closeRelay().catch((error: unknown) => {
    errors.push(
      `relay:${error instanceof Error ? error.name : 'unknown'}`
    );
  });
  const graceful = Promise.all([httpDrained, relayDrained]);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const forced = await Promise.race([
    graceful.then(() => false),
    new Promise<true>((resolve) => {
      timeout = setTimeout(() => {
        log({
          ts: new Date().toISOString(),
          severity: 'error',
          event: 'shutdown.force_timeout',
          timeoutMs,
        });
        input.server.closeAllConnections?.();
        resolve(true);
      }, timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);

  try {
    await input.closeDatabase();
  } catch (error) {
    errors.push(
      `database:${error instanceof Error ? error.name : 'unknown'}`
    );
  }
  return { forced, errors };
}
