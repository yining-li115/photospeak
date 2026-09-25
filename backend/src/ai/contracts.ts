import { z } from 'zod';

const MAX_IMAGE_DATA_URL_CHARS = 3_000_000;

function dataUrlMimeMatchesBytes(value: string): boolean {
  const match = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(
    value
  );
  if (!match) return false;
  const bytes = Buffer.from(match[2].replace(/[\r\n]/g, '').slice(0, 32), 'base64');
  const mime = match[1];
  if (mime === 'jpeg' || mime === 'jpg') {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mime === 'png') {
    return (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  return (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

/**
 * The mobile app sends a normalized, size-bounded JPEG rather than the raw
 * camera asset. Keeping this as a data URL for now avoids a storage dependency
 * while still giving the API a narrow, provider-independent contract.
 */
export const photoDataUrlSchema = z
  .string()
  .min(32)
  .max(MAX_IMAGE_DATA_URL_CHARS)
  .refine(
    (value) =>
      /^data:image\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(
        value
      ),
    'photo_data_url must be a base64 JPEG, PNG, or WebP data URL'
  )
  .refine(
    dataUrlMimeMatchesBytes,
    'photo_data_url media type must match the encoded image bytes'
  );

export const correctedSentenceSchema = z
  .object({
    original: z.string().min(1).max(1_000),
    corrected: z.string().min(1).max(1_000),
    error_type: z.enum([
      'grammar',
      'vocabulary',
      'preposition',
      'article',
      'other',
    ]),
    explanation: z.string().max(1_500),
    is_common_for_chinese_speakers: z.boolean(),
  })
  .strict();

export const chunkSchema = z
  .object({
    id: z.string().min(1).max(100),
    chunk: z.string().min(2).max(200),
    usage_note: z.string().min(1).max(1_500),
    examples: z
      .array(
        z
          .object({ text: z.string().min(1).max(800) })
          .strict()
      )
      .length(2),
  })
  .strict();

export const analysisResultSchema = z
  .object({
    corrected_sentences: z.array(correctedSentenceSchema).max(24),
    polished_sentences: z.array(z.string().min(1).max(800)).min(1).max(12),
    chunks: z.array(chunkSchema).max(5),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set(value.chunks.map((chunk) => chunk.id));
    if (ids.size !== value.chunks.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['chunks'],
        message: 'chunk ids must be unique',
      });
    }
  });

export type AnalysisResult = z.infer<typeof analysisResultSchema>;

const sessionAnalysisRequestSchema = z
  .object({
    operation: z.literal('session_analysis'),
    client_session_id: z.uuid(),
    photo_data_url: photoDataUrlSchema,
    transcript: z.string().trim().min(1).max(12_000),
    mode: z.enum(['polish', 'expand']).default('polish'),
  })
  .strict();

const followUpRequestSchema = z
  .object({
    operation: z.literal('follow_up'),
    client_session_id: z.uuid(),
    photo_data_url: photoDataUrlSchema,
    transcript: z.string().trim().min(1).max(12_000),
    analysis: analysisResultSchema,
    history: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.string().trim().min(1).max(4_000),
          })
          .strict()
      )
      .max(12),
    question: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const analyzeRequestSchema = z.discriminatedUnion('operation', [
  sessionAnalysisRequestSchema,
  followUpRequestSchema,
]);

export type AnalyzeRequest = z.infer<typeof analyzeRequestSchema>;

export const ttsRequestSchema = z
  .object({
    text: z.string().trim().min(1).max(1_500),
    style: z
      .enum(['neutral', 'warm', 'encouraging', 'slow'])
      .default('neutral'),
  })
  .strict();

export type TtsRequest = z.infer<typeof ttsRequestSchema>;

export function parseAnalysisContent(raw: string): AnalysisResult {
  const trimmed = raw.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const jsonText = match ? match[1] : trimmed;
  return analysisResultSchema.parse(JSON.parse(jsonText));
}
