import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import WebSocket, { type ClientOptions, type RawData } from 'ws';
import { safeLogReference } from '../logging/safe-reference.js';
import type {
  StreamingTranscriptionProvider,
  TranscriptionProviderEvent,
  TranscriptionProviderSession,
  TranscriptionSessionContext,
} from './provider.js';
import {
  encodeVolcengineAudio,
  encodeVolcengineConfig,
  extractVolcengineResult,
  parseVolcengineServerFrame,
  type VolcengineAsrRequest,
} from './volcengine-protocol.js';

const PCM_BYTES_PER_MILLISECOND = 16_000 * 2 / 1_000;
const MAX_PROVIDER_MESSAGE_BYTES = 512 * 1024;

export interface VolcengineAsrProviderConfig {
  apiKey: string;
  upstreamUrl: string;
  resourceId: string;
  enableNonstream: boolean;
  vadSilenceMs: number;
  packetMs?: number;
  pricePerAudioHour?: number;
  billingCurrency?: string;
  /** Test seam; production always uses the default `ws` constructor. */
  webSocketFactory?: (url: string, options: ClientOptions) => WebSocket;
}

export class VolcengineAsrProvider
  implements StreamingTranscriptionProvider
{
  readonly name = 'volcengine-speech';
  readonly model = 'seed-asr-2.0';
  readonly billing?: {
    currency: string;
    pricePerAudioHour: number;
  };

  constructor(private readonly config: VolcengineAsrProviderConfig) {
    if (config.pricePerAudioHour !== undefined) {
      this.billing = {
        currency: config.billingCurrency ?? 'CNY',
        pricePerAudioHour: config.pricePerAudioHour,
      };
    }
  }

  createSession(
    context: TranscriptionSessionContext
  ): TranscriptionProviderSession {
    return new VolcengineAsrSession(this.config, context);
  }
}

class VolcengineAsrSession implements TranscriptionProviderSession {
  private readonly socket: WebSocket;
  private readonly packetBytes: number;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private ready = false;
  private finishing = false;
  private ended = false;
  private latestTranscript = '';

  constructor(
    private readonly config: VolcengineAsrProviderConfig,
    private readonly context: TranscriptionSessionContext
  ) {
    this.packetBytes = Math.max(
      3_200,
      Math.round((config.packetMs ?? 200) * PCM_BYTES_PER_MILLISECOND)
    );
    const options: ClientOptions = {
      headers: {
        'X-Api-Key': config.apiKey,
        'X-Api-Resource-Id': config.resourceId,
        'X-Api-Request-Id': context.requestId,
        'X-Api-Sequence': '-1',
        'X-Api-Connect-Id': randomUUID(),
      },
      maxPayload: MAX_PROVIDER_MESSAGE_BYTES,
      perMessageDeflate: false,
    };
    this.socket = config.webSocketFactory
      ? config.webSocketFactory(config.upstreamUrl, options)
      : new WebSocket(config.upstreamUrl, options);
    this.bindSocket();
  }

  get bufferedAmount(): number {
    return this.pendingBytes + this.socket.bufferedAmount;
  }

  sendAudio(pcm: Buffer): void {
    if (this.ended || this.finishing || !this.ready) {
      throw new Error('Volcengine ASR session is not ready for audio');
    }
    this.pending.push(pcm);
    this.pendingBytes += pcm.byteLength;
    while (this.pendingBytes >= this.packetBytes) {
      const combined = Buffer.concat(this.pending, this.pendingBytes);
      const packet = combined.subarray(0, this.packetBytes);
      const remainder = combined.subarray(this.packetBytes);
      this.pending = remainder.byteLength > 0 ? [remainder] : [];
      this.pendingBytes = remainder.byteLength;
      this.sendFrame(encodeVolcengineAudio(packet, false));
    }
  }

  finish(): void {
    if (this.ended || this.finishing) return;
    this.finishing = true;
    const last = Buffer.concat(this.pending, this.pendingBytes);
    this.pending = [];
    this.pendingBytes = 0;
    this.sendFrame(encodeVolcengineAudio(last, true));
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    this.pending = [];
    this.pendingBytes = 0;
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
  }

  private bindSocket(): void {
    this.socket.on('open', () => {
      const request: VolcengineAsrRequest = {
        user: { uid: this.context.userId },
        audio: {
          format: 'pcm',
          codec: 'raw',
          rate: 16000,
          bits: 16,
          channel: 1,
        },
        request: {
          model_name: 'bigmodel',
          enable_nonstream: this.config.enableNonstream,
          enable_itn: true,
          enable_punc: true,
          enable_ddc: false,
          show_utterances: true,
          result_type: 'full',
          end_window_size: this.config.vadSilenceMs,
        },
      };
      this.sendFrame(encodeVolcengineConfig(request));
    });

    this.socket.on('message', (data, isBinary) => {
      if (!isBinary || rawDataLength(data) > MAX_PROVIDER_MESSAGE_BYTES) {
        this.fail('UPSTREAM_PROTOCOL', 'invalid transcription response');
        return;
      }
      try {
        const frame = parseVolcengineServerFrame(rawDataToBuffer(data));
        if (frame.type === 'error') {
          console.warn(
            JSON.stringify({
              ts: new Date().toISOString(),
              event: 'transcribe.upstream_rejected',
              provider: 'volcengine-speech',
              requestRef: safeLogReference(
                'transcription-request',
                this.context.requestId
              ),
              code: frame.code,
              message: frame.message,
            })
          );
          this.fail(
            `UPSTREAM_${frame.code}`,
            'transcription service rejected the request'
          );
          return;
        }

        if (!this.ready) {
          this.ready = true;
          this.emit({ type: 'ready' });
        }
        const result = extractVolcengineResult(frame.payload);
        if (result && result.text !== this.latestTranscript) {
          this.latestTranscript = result.text;
          this.emit({
            type: 'transcript',
            text: result.text,
            final: result.final,
          });
        }
        if (frame.isLast) {
          this.ended = true;
          this.emit({ type: 'completed', text: this.latestTranscript });
          this.socket.close(1000);
        }
      } catch (error) {
        console.warn(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: 'transcribe.protocol_failed',
            provider: 'volcengine-speech',
            requestRef: safeLogReference(
              'transcription-request',
              this.context.requestId
            ),
            message: error instanceof Error ? error.message : String(error),
          })
        );
        this.fail('UPSTREAM_PROTOCOL', 'invalid transcription response');
      }
    });

    this.socket.on(
      'unexpected-response',
      (_request, response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        const logId = response.headers['x-tt-logid'];
        console.warn(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: 'transcribe.handshake_rejected',
            provider: 'volcengine-speech',
            requestRef: safeLogReference(
              'transcription-request',
              this.context.requestId
            ),
            status,
            logId: typeof logId === 'string' ? logId : undefined,
          })
        );
        this.fail(
          status === 401 || status === 403
            ? 'UPSTREAM_CREDENTIALS'
            : 'UPSTREAM_UNAVAILABLE',
          'transcription service unavailable'
        );
      }
    );
    this.socket.on('error', () => {
      this.fail('UPSTREAM_UNAVAILABLE', 'transcription service unavailable');
    });
    this.socket.on('close', () => {
      if (!this.ended) {
        this.fail('UPSTREAM_CLOSED', 'transcription service disconnected');
      }
    });
  }

  private sendFrame(frame: Buffer): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Volcengine ASR upstream is not open');
    }
    this.socket.send(frame, { binary: true });
  }

  private emit(event: TranscriptionProviderEvent): void {
    this.context.onEvent(event);
  }

  private fail(code: string, message: string): void {
    if (this.ended) return;
    this.ended = true;
    this.pending = [];
    this.pendingBytes = 0;
    this.emit({ type: 'failed', code, message });
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
  }
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(new Uint8Array(data));
}

function rawDataLength(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, part) => total + part.byteLength, 0);
  }
  return data.byteLength;
}
