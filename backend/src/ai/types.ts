export type AiTextContent = {
  type: 'text';
  text: string;
};

export type AiImageContent = {
  type: 'image_url';
  image_url: { url: string };
};

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | (AiTextContent | AiImageContent)[];
}

export type AiUsageUnit = 'tokens' | 'characters';

export interface AiUsage {
  unit: AiUsageUnit;
  inputUnits?: number;
  outputUnits?: number;
}

export interface AiTextResult {
  content: string;
  usage?: AiUsage;
}

export interface AiSpeechResult {
  base64: string;
  transcript?: string;
  usage?: AiUsage;
}

export interface TextCompletionInput {
  messages: AiChatMessage[];
  maxOutputTokens: number;
  temperature: number;
  /** Stable per logical operation; only native-capable adapters may forward it. */
  providerIdempotencyKey: string;
}

export interface SpeechSynthesisInput {
  text: string;
  style: 'neutral' | 'warm' | 'encouraging' | 'slow';
  providerIdempotencyKey: string;
}

export type ProviderIdempotencyCapability =
  | 'none'
  | 'native_replay'
  | 'queryable_job';

/** Vision/text boundary. It may be served by Ark independently of speech. */
export interface TextAiProvider {
  readonly name: string;
  readonly chatModel: string;
  readonly usageUnit: 'tokens';
  readonly idempotencyCapability: ProviderIdempotencyCapability;
  completeText(input: TextCompletionInput): Promise<AiTextResult>;
}

/** Speech boundary. Volcengine speech uses different auth/protocols from Ark. */
export interface SpeechAiProvider {
  readonly name: string;
  readonly ttsModel: string;
  readonly ttsVoice: string;
  readonly ttsFormat: 'wav' | 'mp3' | 'ogg_opus';
  readonly usageUnit: AiUsageUnit;
  readonly idempotencyCapability: ProviderIdempotencyCapability;
  synthesizeSpeech(input: SpeechSynthesisInput): Promise<AiSpeechResult>;
}

export interface ModerationInput {
  text: string;
  imageDataUrl?: string;
}

export interface ModerationResult {
  allowed: boolean;
  categories?: string[];
}

/** Optional hook for a provider-specific image/text safety service. */
export interface ModerationProvider {
  readonly name: string;
  moderate(input: ModerationInput): Promise<ModerationResult>;
}

export type AiProviderErrorKind =
  | 'timeout'
  | 'rate_limited'
  | 'authentication'
  | 'billing'
  | 'configuration'
  | 'bad_response'
  | 'unavailable';

export class AiProviderError extends Error {
  constructor(
    public readonly kind: AiProviderErrorKind,
    message: string,
    public readonly upstreamStatus?: number,
    /** Provider-owned machine code only. Never place upstream messages here. */
    public readonly upstreamCode?: string
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}
