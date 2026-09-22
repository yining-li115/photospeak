import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import { recordUsage } from '../ai/usage.js';
import type {
  StreamingTranscriptionProvider,
  TranscriptionProviderEvent,
  TranscriptionProviderSession,
} from './provider.js';

export const TRANSCRIBE_WS_PATH = '/api/transcribe/stream';
const TICKET_TTL_MS = 15_000;
// The relay opens before native recording starts and must remain alive while
// the provider finalizes its last sentence. Audio itself is capped separately
// at exactly 70 seconds of 16 kHz mono PCM16; connection overhead must not
// steal time from the product's 60s + 10s recording promise.
// 8s provider task-start budget + 70s audio + 10s finalization is already 88s.
// Keep explicit jitter margin here; the independent byte cap, not this socket
// lifetime, enforces the product's maximum recorded-audio duration.
const MAX_SESSION_MS = 105_000;
const MAX_AUDIO_SECONDS = 70;
const PCM_BYTES_PER_SECOND = 16_000 * 2;
const MAX_PCM_BYTES = MAX_AUDIO_SECONDS * PCM_BYTES_PER_SECOND;
const MAX_UPSTREAM_BUFFERED_BYTES = 1_000_000;

interface TicketRecord {
  userId: string;
  plan: string;
  sessionId: string;
  expiresAt: number;
}

interface RelayConfig {
  provider: StreamingTranscriptionProvider;
  maxConcurrent?: number;
  maxConcurrentPerUser?: number;
}

const tickets = new Map<string, TicketRecord>();

/**
 * Mint a one-use credential for our own relay. Unlike a provider credential,
 * this ticket cannot call another model or endpoint.
 */
export function issueTranscriptionTicket(userId: string, plan: string): {
  ticket: string;
  sessionId: string;
  expiresAt: number;
} {
  const now = Date.now();
  purgeExpiredTickets(now);
  const ticket = randomBytes(32).toString('base64url');
  const record: TicketRecord = {
    userId,
    plan,
    sessionId: randomUUID(),
    expiresAt: now + TICKET_TTL_MS,
  };
  tickets.set(ticket, record);
  return { ticket, sessionId: record.sessionId, expiresAt: record.expiresAt };
}

/** Attach the constrained mobile↔provider binary relay to the HTTP server. */
export function attachTranscriptionRelay(
  server: Server,
  config: RelayConfig
): { close: () => Promise<void> } {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 256 * 1024,
    perMessageDeflate: false,
  });
  const activeByUser = new Map<string, number>();
  const usageWrites = new Set<Promise<void>>();
  let activeTotal = 0;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const globalLimit = positiveInteger(config.maxConcurrent, 12);
  const userLimit = positiveInteger(config.maxConcurrentPerUser, 1);

  const handleUpgrade: Parameters<Server['on']>[1] = (
    request,
    socket,
    head
  ) => {
    if (closing) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://localhost');
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }
    if (url.pathname !== TRANSCRIBE_WS_PATH) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    const rawTicket = request.headers['x-photospeak-transcribe-ticket'];
    const ticketValue = Array.isArray(rawTicket) ? rawTicket[0] : rawTicket ?? '';
    const ticket = consumeTicket(ticketValue);
    if (!ticket) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    const userActive = activeByUser.get(ticket.userId) ?? 0;
    if (activeTotal >= globalLimit || userActive >= userLimit) {
      rejectUpgrade(socket, 429, 'Too Many Requests');
      return;
    }

    activeTotal += 1;
    activeByUser.set(ticket.userId, userActive + 1);
    wss.handleUpgrade(request, socket, head, (client) => {
      runRelay(
        client,
        ticket,
        config,
        () => {
          activeTotal = Math.max(0, activeTotal - 1);
          const remaining = (activeByUser.get(ticket.userId) ?? 1) - 1;
          if (remaining > 0) activeByUser.set(ticket.userId, remaining);
          else activeByUser.delete(ticket.userId);
        },
        (write) => {
          usageWrites.add(write);
          void write.finally(() => usageWrites.delete(write));
        }
      );
    });
  };
  server.on('upgrade', handleUpgrade);

  return {
    close: () => {
      closePromise ??= (async () => {
        closing = true;
        tickets.clear();
        for (const client of wss.clients) client.terminate();
        await new Promise<void>((resolve, reject) => {
          wss.close((error) => (error ? reject(error) : resolve()));
        });
        server.off('upgrade', handleUpgrade);
        await Promise.allSettled([...usageWrites]);
      })();
      return closePromise;
    },
  };
}

function runRelay(
  client: WebSocket,
  ticket: TicketRecord,
  config: RelayConfig,
  release: () => void,
  trackUsage: (write: Promise<void>) => void
): void {
  const startedAt = Date.now();
  const taskId = ticket.sessionId.replace(/-/g, '');
  let pcmBytes = 0;
  let settled = false;
  let finishRequested = false;
  let latestTranscript = '';
  let providerSession: TranscriptionProviderSession | null = null;

  const settle = (
    status: 'succeeded' | 'failed',
    errorCode?: string
  ): void => {
    if (settled) return;
    settled = true;
    clearTimeout(hardTimeout);
    release();
    const usageWrite = recordUsage({
      requestId: ticket.sessionId,
      operationId: ticket.sessionId,
      userId: ticket.userId,
      capability: 'transcribe',
      provider: config.provider.name,
      model: config.provider.model,
      plan: ticket.plan,
      status,
      inputUnits: Math.ceil(pcmBytes / 32_000),
      ...estimateCost(config.provider, pcmBytes),
      latencyMs: Date.now() - startedAt,
      errorCode,
    }).catch((error) => {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: 'transcribe.usage.failed',
          sessionId: ticket.sessionId,
          message: error instanceof Error ? error.message : String(error),
        })
      );
    });
    trackUsage(usageWrite);
  };

  const fail = (code: string, message: string): void => {
    if (settled) return;
    if (client.readyState === WebSocket.OPEN) {
      client.send(
        JSON.stringify({
          type: 'transcription.failed',
          code,
          message,
          header: {
            event: 'task-failed',
            task_id: taskId,
            error_code: code,
            error_message: message,
          },
          payload: {},
        })
      );
      client.close(1011, 'transcription failed');
    }
    providerSession?.close();
    settle('failed', code.toLowerCase());
  };

  const hardTimeout = setTimeout(
    () => fail('SESSION_LIMIT', 'recording exceeded the server limit'),
    MAX_SESSION_MS
  );

  try {
    const created = config.provider.createSession({
      requestId: ticket.sessionId,
      userId: ticket.userId,
      onEvent: (event) => {
        if (settled) return;
        handleProviderEvent(event);
      },
    });
    providerSession = created;
    // A test adapter or a future in-process provider may report a terminal
    // event synchronously from createSession(). Do not leak that session.
    if (settled) created.close();
  } catch (error) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'transcribe.provider_create_failed',
        provider: config.provider.name,
        sessionId: ticket.sessionId,
        message: error instanceof Error ? error.message : String(error),
      })
    );
    fail('UPSTREAM_UNAVAILABLE', 'transcription service unavailable');
    return;
  }

  function handleProviderEvent(event: TranscriptionProviderEvent): void {
    switch (event.type) {
      case 'ready':
        sendClientEvent(client, {
          type: 'transcription.ready',
          session_id: ticket.sessionId,
          // Transitional compatibility for already-distributed beta builds.
          header: { event: 'task-started', task_id: taskId },
        });
        return;
      case 'transcript':
        latestTranscript = event.text;
        sendClientEvent(client, {
          type: 'transcription.update',
          text: event.text,
          final: event.final,
          header: { event: 'result-generated', task_id: taskId },
          payload: {
            output: {
              sentence: {
                begin_time: 0,
                text: event.text,
                sentence_end: event.final,
              },
            },
          },
        });
        return;
      case 'completed': {
        const text = event.text || latestTranscript;
        sendClientEvent(client, {
          type: 'transcription.completed',
          text,
          header: { event: 'task-finished', task_id: taskId },
          payload: {},
        });
        settle('succeeded');
        providerSession?.close();
        if (client.readyState === WebSocket.OPEN) client.close(1000);
        return;
      }
      case 'failed':
        fail(event.code, event.message);
    }
  }

  client.on('message', (data, isBinary) => {
    if (settled) return;
    if (isBinary) {
      const bytes = rawDataToBuffer(data);
      pcmBytes += bytes.byteLength;
      if (pcmBytes > MAX_PCM_BYTES) {
        fail('AUDIO_TOO_LARGE', 'recording exceeded the audio limit');
        return;
      }
      if (
        (providerSession?.bufferedAmount ?? 0) > MAX_UPSTREAM_BUFFERED_BYTES
      ) {
        fail('UPSTREAM_BACKPRESSURE', 'transcription stream is unavailable');
        return;
      }
      try {
        providerSession?.sendAudio(bytes);
      } catch {
        fail('UPSTREAM_UNAVAILABLE', 'transcription stream is unavailable');
      }
      return;
    }

    let command: unknown;
    try {
      command = JSON.parse(rawDataToBuffer(data).toString());
    } catch {
      fail('INVALID_COMMAND', 'invalid relay command');
      return;
    }
    if (
      finishRequested ||
      typeof command !== 'object' ||
      command === null ||
      (command as { type?: unknown }).type !== 'finish'
    ) {
      fail('INVALID_COMMAND', 'invalid relay command');
      return;
    }
    finishRequested = true;
    try {
      providerSession?.finish();
    } catch {
      fail('UPSTREAM_UNAVAILABLE', 'transcription service unavailable');
    }
  });

  client.on('error', () => {
    if (!settled) settle('failed', 'client_error');
    providerSession?.close();
  });
  client.on('close', () => {
    if (!settled) settle('failed', 'client_closed');
    providerSession?.close();
  });
}

function consumeTicket(value: string): TicketRecord | null {
  if (!value) return null;
  const ticket = tickets.get(value);
  tickets.delete(value);
  if (!ticket || ticket.expiresAt <= Date.now()) return null;
  return ticket;
}

function purgeExpiredTickets(now: number): void {
  for (const [value, ticket] of tickets) {
    if (ticket.expiresAt <= now) tickets.delete(value);
  }
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(new Uint8Array(data));
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
  );
  socket.destroy();
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function sendClientEvent(
  client: WebSocket,
  event: Record<string, unknown>
): void {
  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(event));
  }
}

function estimateCost(
  provider: StreamingTranscriptionProvider,
  pcmBytes: number
): { estimatedCostMicros?: number; billingCurrency?: string } {
  if (!provider.billing) return {};
  const seconds = pcmBytes / PCM_BYTES_PER_SECOND;
  return {
    estimatedCostMicros: Math.max(
      0,
      Math.round(
        (seconds / 3_600) * provider.billing.pricePerAudioHour * 1_000_000
      )
    ),
    billingCurrency: provider.billing.currency,
  };
}
