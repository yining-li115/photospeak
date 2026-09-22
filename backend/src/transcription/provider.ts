export type TranscriptionProviderEvent =
  | { type: 'ready' }
  | {
      type: 'transcript';
      text: string;
      /** True when every currently returned utterance is provider-final. */
      final: boolean;
    }
  | { type: 'completed'; text: string }
  | { type: 'failed'; code: string; message: string };

export interface TranscriptionProviderSession {
  /** Bytes waiting in either the provider adapter or the upstream socket. */
  readonly bufferedAmount: number;
  sendAudio(pcm: Buffer): void;
  finish(): void;
  close(): void;
}

export interface TranscriptionSessionContext {
  requestId: string;
  userId: string;
  onEvent: (event: TranscriptionProviderEvent) => void;
}

/**
 * Provider boundary for real-time speech recognition.
 *
 * The mobile relay owns authentication, byte/time limits and usage accounting;
 * adapters own only the vendor handshake, wire protocol and result mapping.
 */
export interface StreamingTranscriptionProvider {
  readonly name: string;
  readonly model: string;
  readonly billing?: {
    currency: string;
    pricePerAudioHour: number;
  };
  createSession(
    context: TranscriptionSessionContext
  ): TranscriptionProviderSession;
}
