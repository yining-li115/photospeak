/**
 * DashScope paraformer-realtime-v2 streaming client.
 *
 * Architecture (per docs/optimization.md, replaces the prior batch
 * POST /api/transcribe path):
 *
 *   1. Client asks our backend for a short-lived DashScope token
 *      (POST /api/transcribe/token). Backend holds the long-lived
 *      DASHSCOPE_API_KEY and signs a 5-minute delegation. Audio bytes
 *      never transit the backend.
 *   2. Client opens a WebSocket directly to DashScope using that
 *      token in the Authorization header.
 *   3. Client sends a `run-task` JSON message, waits for
 *      `task-started`, then streams PCM 16-bit @ 16kHz mono as binary
 *      frames while recording.
 *   4. On stop, client sends `finish-task` and reads
 *      `result-generated` events to build the final transcript. The
 *      protocol delivers sentence-level partials keyed by
 *      `begin_time`; we keep the last update for each begin_time and
 *      concat at the end.
 *
 * This mirrors how OpenAI Realtime, AssemblyAI streaming, and
 * Deepgram structure their mobile flows.
 */
import { backendRequest } from './backend';

export class AliyunAsrError extends Error {
  constructor(
    message: string,
    public readonly stage?: 'token' | 'connect' | 'stream' | 'finalize'
  ) {
    super(message);
    this.name = 'AliyunAsrError';
  }
}

interface TokenResponse {
  token: string;
  expires_at: number;
  ws_url: string;
  session_id: string;
  model: string;
}

interface DashScopeServerMessage {
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

/**
 * One live streaming-ASR session. Lifecycle:
 *   create() → sendAudio() … sendAudio() → finish() → final transcript
 *
 * If anything fails partway, finish() rejects with an AliyunAsrError
 * tagged with the stage so the caller can log it usefully. The
 * underlying WebSocket is always closed on either resolution path.
 */
export class TranscriptionSession {
  private ws: WebSocket;
  private taskId: string;
  private sessionId: string;
  private started: Promise<void>;
  private finishedResolve!: (transcript: string) => void;
  private finishedReject!: (err: Error) => void;
  private finished: Promise<string>;
  // Keyed by sentence begin_time. paraformer streams the same
  // sentence multiple times with growing text as it firms up; the
  // last update for each begin_time is the finalised form (or as
  // finalised as we'll get before task-finished). Map preserves
  // insertion order, which equals temporal order for our case.
  private sentences = new Map<number, string>();
  private closed = false;

  private constructor(ws: WebSocket, taskId: string, sessionId: string) {
    this.ws = ws;
    this.taskId = taskId;
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
      let msg: DashScopeServerMessage;
      try {
        msg = JSON.parse(ev.data) as DashScopeServerMessage;
      } catch {
        return;
      }
      const event = msg.header?.event;
      if (event === 'task-started') {
        startedResolve();
        return;
      }
      if (event === 'result-generated') {
        const s = msg.payload?.output?.sentence;
        if (s && typeof s.text === 'string' && typeof s.begin_time === 'number') {
          this.sentences.set(s.begin_time, s.text);
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
        const stage = this.sentences.size > 0 ? 'finalize' : 'stream';
        const err = new AliyunAsrError(`DashScope ASR: ${code} — ${message}`, stage);
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
      const err = new AliyunAsrError(
        `WebSocket closed before finish: ${reason}`,
        'stream'
      );
      startedReject(err);
      this.finishedReject(err);
    };
  }

  /**
   * Open a session: fetch a token from our backend, connect to
   * DashScope, send `run-task`, wait for `task-started`. Resolves
   * once the session is ready to receive audio frames.
   */
  static async create(): Promise<TranscriptionSession> {
    let tokenInfo: TokenResponse;
    try {
      tokenInfo = await backendRequest<TokenResponse>(
        'POST',
        '/api/transcribe/token'
      );
    } catch (e) {
      throw new AliyunAsrError(
        e instanceof Error ? e.message : `token fetch failed: ${String(e)}`,
        'token'
      );
    }

    if (!tokenInfo.token || !tokenInfo.ws_url) {
      throw new AliyunAsrError('backend returned invalid token payload', 'token');
    }

    const taskId = tokenInfo.session_id.replace(/-/g, '');
    // React Native's WebSocket extends the browser API with a third
    // `options` argument that accepts custom headers during the
    // upgrade handshake. TypeScript's lib.dom doesn't model that, so
    // we cast the constructor to the RN signature locally.
    const RNWebSocket = WebSocket as unknown as new (
      url: string,
      protocols?: string | string[],
      options?: { headers?: Record<string, string> }
    ) => WebSocket;
    const ws = new RNWebSocket(tokenInfo.ws_url, undefined, {
      headers: { Authorization: `Bearer ${tokenInfo.token}` },
    });
    ws.binaryType = 'arraybuffer';

    const session = new TranscriptionSession(ws, taskId, tokenInfo.session_id);

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
        resolve();
      };
      const onError = () => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
        reject(new AliyunAsrError('WebSocket connect failed', 'connect'));
      };
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
    });

    ws.send(
      JSON.stringify({
        header: {
          action: 'run-task',
          task_id: taskId,
          streaming: 'duplex',
        },
        payload: {
          task_group: 'audio',
          task: 'asr',
          function: 'recognition',
          model: tokenInfo.model || 'paraformer-realtime-v2',
          parameters: {
            format: 'pcm',
            sample_rate: 16000,
            // Bilingual hint covers our typical user — Chinese
            // speaker describing photos in English with occasional
            // code-switching back to Chinese. paraformer treats
            // language_hints as guidance, not a hard filter.
            language_hints: ['en', 'zh'],
          },
          input: {},
        },
      })
    );

    await session.started;
    return session;
  }

  /**
   * Push one PCM 16-bit @ 16kHz mono chunk. Accepts the base64
   * payload that @siteed/audio-studio emits in its `onAudioStream`
   * callback. Throws if the underlying WS is no longer open (caller
   * should treat this as a fatal error for the session).
   */
  sendAudio(base64Pcm: string): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      throw new AliyunAsrError('cannot send audio: session not open', 'stream');
    }
    this.ws.send(base64ToArrayBuffer(base64Pcm));
  }

  /**
   * Tell the server we're done speaking. Resolves with the final
   * transcript once `task-finished` arrives. Always closes the WS.
   */
  async finish(): Promise<string> {
    if (this.closed) return this.finished;
    if (this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(
          JSON.stringify({
            header: {
              action: 'finish-task',
              task_id: this.taskId,
              streaming: 'duplex',
            },
            payload: { input: {} },
          })
        );
      } catch (e) {
        const err = new AliyunAsrError(
          e instanceof Error ? e.message : 'finish-task send failed',
          'finalize'
        );
        this.finishedReject(err);
        this.close();
        throw err;
      }
    }
    return this.finished;
  }

  /** Abort without waiting for a transcript. Safe to call multiple times. */
  cancel(): void {
    if (this.closed) return;
    this.finishedReject(
      new AliyunAsrError('session cancelled', 'stream')
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
    // Map iteration is insertion-ordered; insertion order matches
    // the temporal order the server first mentioned each sentence,
    // which equals the playback order. join with no separator —
    // paraformer already embeds punctuation in the text.
    let out = '';
    for (const text of this.sentences.values()) out += text;
    return out.trim();
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
