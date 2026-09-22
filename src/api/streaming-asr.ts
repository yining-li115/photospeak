/**
 * Provider-neutral streaming transcription client.
 *
 * Architecture (per docs/optimization.md, replaces the prior batch
 * POST /api/transcribe path):
 *
 *   1. Client asks our backend for a short-lived, one-use relay ticket.
 *   2. Client opens a WebSocket to PhotoSpeak's constrained relay. Provider
 *      credentials, models and binary protocols stay server-side.
 *   3. Client waits for `transcription.ready`, then streams PCM 16-bit @ 16kHz mono
 *      as binary frames while recording.
 *   4. On stop, client sends a provider-neutral finish command and reads the
 *      latest full transcript until `transcription.completed` arrives.
 *
 * This mirrors how OpenAI Realtime, AssemblyAI streaming, and
 * Deepgram structure their mobile flows.
 */
import { backendRequest, backendWebSocketUrl } from './backend';

export class TranscriptionError extends Error {
  constructor(
    message: string,
    public readonly stage?: 'token' | 'connect' | 'stream' | 'finalize'
  ) {
    super(message);
    this.name = 'TranscriptionError';
  }
}

/**
 * Map a transcription failure to a short, user-facing Chinese
 * message that suggests what to do next. The underlying `err`
 * usually has a stage label (token / connect / stream / finalize)
 * that tells us *where* in the pipeline things broke; we use that
 * to give a hint rather than a generic "something failed".
 *
 * Always pair with a `console.warn` of the raw error so we keep the
 * technical detail in logs for debugging.
 */
export function friendlyTranscribeMessage(err: unknown): string {
  if (err instanceof TranscriptionError) {
    switch (err.stage) {
      case 'token':
        // Backend unreachable or auth issue — almost always the
        // user's network. Encourage them to check it first.
        return '网络不太稳，请检查后重新录一次';
      case 'connect':
        // Token in hand, but the upstream WebSocket didn't open.
        return '语音服务暂时连不上，稍后再试';
      case 'stream':
        // Mid-stream disconnect — usually network flapped.
        return '录音中断了，请重新录一次';
      case 'finalize':
        return '识别出了点问题，请重新录一次';
    }
  }
  return '识别失败，请重新录一次';
}

interface RelaySessionResponse {
  ticket: string;
  expires_at: number;
  ws_path: string;
  session_id: string;
}

interface RelayServerMessage {
  type?:
    | 'transcription.ready'
    | 'transcription.update'
    | 'transcription.completed'
    | 'transcription.failed';
  text?: string;
  final?: boolean;
  code?: string;
  message?: string;
  // Legacy compatibility fields used by already-distributed beta builds.
  header?: {
    task_id?: string;
    event?: 'task-started' | 'result-generated' | 'task-finished' | 'task-failed';
    error_code?: string;
    error_message?: string;
  };
  payload?: {
    output?: {
      sentence?: {
        begin_time?: number | null;
        end_time?: number | null;
        text?: string;
        sentence_end?: boolean;
      };
    };
  };
}

const TOKEN_REQUEST_TIMEOUT_MS = 10_000;
const WEBSOCKET_CONNECT_TIMEOUT_MS = 8_000;
const TASK_START_TIMEOUT_MS = 8_000;
const TASK_FINISH_TIMEOUT_MS = 10_000;

export interface TranscriptionSessionOptions {
  /** Cancels token acquisition / the WebSocket handshake. */
  signal?: AbortSignal;
}

/**
 * One live streaming-ASR session. Lifecycle:
 *   create() → sendAudio() … sendAudio() → finish() → final transcript
 *
 * If anything fails partway, finish() rejects with a TranscriptionError
 * tagged with the stage so the caller can log it usefully. The
 * underlying WebSocket is always closed on either resolution path.
 */
export class TranscriptionSession {
  private ws: WebSocket;
  private sessionId: string;
  private started: Promise<void>;
  private finishedResolve!: (transcript: string) => void;
  private finishedReject!: (err: Error) => void;
  private finished: Promise<string>;
  private latestTranscript = '';
  // Old beta relays emitted one growing sentence per begin_time instead of a
  // complete transcript. Keep this map only for the rolling-deploy fallback;
  // the new provider-neutral event always carries the complete current text.
  private legacySentences = new Map<number, string>();
  private closed = false;
  private finishRequested = false;

  private constructor(ws: WebSocket, sessionId: string) {
    this.ws = ws;
    this.sessionId = sessionId;

    let startedResolve: () => void;
    let startedReject: (err: Error) => void;
    this.started = new Promise<void>((res, rej) => {
      startedResolve = res;
      startedReject = rej;
    });
    this.finished = new Promise<string>((res, rej) => {
      this.finishedResolve = res;
      this.finishedReject = rej;
    });
    // If connect fails before anyone awaits, the constructor's
    // onclose still rejects both promises. Attach a no-op catch so
    // those internal rejections don't surface as
    // "unhandledRejection" warnings — the real consumer (create()
    // for `started`, the recorder hook for `finished`) sees the
    // rejection through its own await.
    this.started.catch(() => {});
    this.finished.catch(() => {});

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return; // server only sends JSON text
      let msg: RelayServerMessage;
      try {
        msg = JSON.parse(ev.data) as RelayServerMessage;
      } catch {
        return;
      }
      if (msg.type === 'transcription.ready') {
        startedResolve();
        return;
      }
      if (msg.type === 'transcription.update') {
        if (typeof msg.text === 'string') this.latestTranscript = msg.text;
        return;
      }
      if (msg.type === 'transcription.completed') {
        const text =
          typeof msg.text === 'string' ? msg.text : this.latestTranscript;
        this.finishedResolve(text.trim());
        this.close();
        return;
      }
      if (msg.type === 'transcription.failed') {
        const err = new TranscriptionError(
          `Streaming ASR: ${msg.code ?? 'unknown'} — ${msg.message ?? 'failed'}`,
          this.latestTranscript ? 'finalize' : 'stream'
        );
        startedReject(err);
        this.finishedReject(err);
        this.close();
        return;
      }

      // Temporary compatibility with the previous relay protocol.
      const event = msg.header?.event;
      if (event === 'task-started') {
        startedResolve();
        return;
      }
      if (event === 'result-generated') {
        const s = msg.payload?.output?.sentence;
        if (s && typeof s.text === 'string' && typeof s.begin_time === 'number') {
          this.legacySentences.set(s.begin_time, s.text);
        }
        return;
      }
      if (event === 'task-finished') {
        this.finishedResolve(this.collectTranscript());
        this.close();
        return;
      }
      if (event === 'task-failed') {
        const code = msg.header?.error_code ?? 'unknown';
        const message = msg.header?.error_message ?? 'task-failed';
        const stage = this.latestTranscript ? 'finalize' : 'stream';
        const err = new TranscriptionError(
          `Streaming ASR: ${code} — ${message}`,
          stage
        );
        startedReject(err);
        this.finishedReject(err);
        this.close();
      }
    };

    ws.onerror = () => {
      // RN's onerror doesn't expose the error object meaningfully.
      // Always pair this with onclose for actual cleanup.
    };

    ws.onclose = (ev) => {
      if (this.closed) return;
      this.closed = true;
      const reason = ev.reason || `code=${ev.code}`;
      const err = new TranscriptionError(
        `WebSocket closed before finish: ${reason}`,
        'stream'
      );
      startedReject(err);
      this.finishedReject(err);
    };
  }

  /**
   * Open a session: fetch a one-use relay ticket, connect to our backend,
   * and wait for its fixed upstream task to emit `task-started`. Resolves once
   * the relay is ready to receive audio frames.
   */
  static async create(
    options: TranscriptionSessionOptions = {}
  ): Promise<TranscriptionSession> {
    const { signal } = options;
    let relayInfo: RelaySessionResponse;
    try {
      relayInfo = await waitWithDeadline(
        backendRequest<RelaySessionResponse>(
          'POST',
          '/api/transcribe/session',
          undefined,
          { signal, timeoutMs: TOKEN_REQUEST_TIMEOUT_MS }
        ),
        {
          timeoutMs: TOKEN_REQUEST_TIMEOUT_MS,
          signal,
          timeoutError: new TranscriptionError(
            'transcription token request timed out',
            'token'
          ),
          abortedError: new TranscriptionError(
            'transcription session creation cancelled',
            'token'
          ),
        }
      );
    } catch (e) {
      if (e instanceof TranscriptionError) throw e;
      throw new TranscriptionError(
        e instanceof Error ? e.message : `token fetch failed: ${String(e)}`,
        'token'
      );
    }

    if (
      typeof relayInfo.ticket !== 'string' ||
      relayInfo.ticket.length < 32 ||
      typeof relayInfo.ws_path !== 'string' ||
      !relayInfo.ws_path.startsWith('/api/transcribe/') ||
      typeof relayInfo.session_id !== 'string' ||
      relayInfo.session_id.length === 0
    ) {
      throw new TranscriptionError(
        'backend returned invalid relay payload',
        'token'
      );
    }

    // React Native's WebSocket extends the browser API with a third
    // `options` argument that accepts custom headers during the
    // upgrade handshake. TypeScript's lib.dom doesn't model that, so
    // we cast the constructor to the RN signature locally.
    const RNWebSocket = WebSocket as unknown as new (
      url: string,
      protocols?: string | string[],
      options?: { headers?: Record<string, string> }
    ) => WebSocket;
    throwIfAborted(signal, 'connect');

    const ws = new RNWebSocket(backendWebSocketUrl(relayInfo.ws_path), undefined, {
      headers: { 'X-PhotoSpeak-Transcribe-Ticket': relayInfo.ticket },
    });
    ws.binaryType = 'arraybuffer';

    const session = new TranscriptionSession(ws, relayInfo.session_id);

    try {
      await waitForWebSocketOpen(ws, signal);

      await waitWithDeadline(session.started, {
        timeoutMs: TASK_START_TIMEOUT_MS,
        signal,
        timeoutError: new TranscriptionError(
          'transcription provider did not acknowledge the task in time',
          'connect'
        ),
        abortedError: new TranscriptionError(
          'transcription session creation cancelled',
          'connect'
        ),
      });
      return session;
    } catch (error) {
      session.cancel();
      throw error;
    }
  }

  /**
   * Push one PCM 16-bit @ 16kHz mono chunk. Accepts the base64
   * payload that @siteed/audio-studio emits in its `onAudioStream`
   * callback. Throws if the underlying WS is no longer open (caller
   * should treat this as a fatal error for the session).
   */
  sendAudio(base64Pcm: string): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      throw new TranscriptionError(
        'cannot send audio: session not open',
        'stream'
      );
    }
    this.ws.send(base64ToArrayBuffer(base64Pcm));
  }

  /**
   * Tell the server we're done speaking. Resolves with the final
   * transcript once `task-finished` arrives. Always closes the WS.
   */
  async finish(): Promise<string> {
    if (this.finishRequested || this.closed) return this.finished;
    this.finishRequested = true;
    if (this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'finish' }));
      } catch (e) {
        const err = new TranscriptionError(
          e instanceof Error ? e.message : 'finish-task send failed',
          'finalize'
        );
        this.finishedReject(err);
        this.close();
        throw err;
      }
    }
    try {
      return await waitWithDeadline(this.finished, {
        timeoutMs: TASK_FINISH_TIMEOUT_MS,
        timeoutError: new TranscriptionError(
          'transcription provider did not finish in time',
          'finalize'
        ),
      });
    } catch (error) {
      const err =
        error instanceof Error
          ? error
          : new TranscriptionError(String(error), 'finalize');
      this.finishedReject(err);
      this.close();
      throw err;
    }
  }

  /** Abort without waiting for a transcript. Safe to call multiple times. */
  cancel(): void {
    if (this.closed) return;
    this.finishedReject(
      new TranscriptionError('session cancelled', 'stream')
    );
    this.close();
  }

  /** For logging/correlation with backend's token-issued event. */
  get id(): string {
    return this.sessionId;
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }

  private collectTranscript(): string {
    if (this.latestTranscript) return this.latestTranscript.trim();
    return [...this.legacySentences.values()].join(' ').trim();
  }
}

interface DeadlineOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  timeoutError: Error;
  abortedError?: Error;
}

/**
 * Race an operation against a deadline and optional AbortSignal.
 * The underlying promise may not be abortable (React Native fetch is
 * provider-dependent), but late settlement is ignored and never leaks an
 * unhandled rejection.
 */
function waitWithDeadline<T>(
  operation: Promise<T>,
  options: DeadlineOptions
): Promise<T> {
  const { timeoutMs, signal, timeoutError } = options;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () =>
      finish(() =>
        reject(
          options.abortedError ??
            new TranscriptionError('operation cancelled', 'connect')
        )
      );
    const timer = setTimeout(
      () => finish(() => reject(timeoutError)),
      timeoutMs
    );

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
  });
}

async function waitForWebSocketOpen(
  ws: WebSocket,
  signal?: AbortSignal
): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      callback();
    };
    const onOpen = () => {
      settle(resolve);
    };
    const onError = () => {
      settle(() =>
        reject(new TranscriptionError('WebSocket connect failed', 'connect'))
      );
    };
    const onAbort = () => {
      settle(() =>
        reject(
          new TranscriptionError(
            'transcription session creation cancelled',
            'connect'
          )
        )
      );
    };
    const cleanup = () => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(
      () =>
        settle(() =>
          reject(
            new TranscriptionError(
              'WebSocket connection timed out',
              'connect'
            )
          )
        ),
      WEBSOCKET_CONNECT_TIMEOUT_MS
    );

    if (signal?.aborted) {
      onAbort();
      return;
    }
    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  stage: 'token' | 'connect' | 'stream' | 'finalize'
): void {
  if (signal?.aborted) {
    throw new TranscriptionError(
      'transcription session creation cancelled',
      stage
    );
  }
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  // React Native exposes global `atob` since 0.71. Avoiding Buffer
  // (Node-only) and avoiding pulling in a base64 lib for two lines.
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
