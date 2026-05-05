import { File } from 'expo-file-system';
import type { ChatMessage, Chunk, CorrectedSentence } from '../types';
import { backendRequest } from './backend';

const MODEL = 'mimo-v2.5';

const POLISH_INSTRUCTION = `Stay faithful to what the user actually said. The polished version should preserve their meaning, length, and structure — fix grammar, word choice, and phrasing, but do NOT add new ideas, observations, or details that weren't in their transcript.`;

const EXPAND_INSTRUCTION = `Treat the user's transcript as the opening of a longer description. Build a natural ~60-second spoken monologue (roughly 8-12 sentences) that starts from what they said and continues by describing the photo more fully — what's in it, the mood, small details worth noticing. The polished version should sound like a fluent speaker thinking aloud, not a written paragraph. Pull "corrected_sentences" only from what the user actually said (do not invent corrections for sentences they didn't speak).`;

function buildSystemPrompt(mode: AnalyzeMode): string {
  const modeInstruction = mode === 'expand' ? EXPAND_INSTRUCTION : POLISH_INSTRUCTION;
  return `You are an English language coach. The user is a native Chinese speaker learning English. Analyze their spoken English description of a photo. Your job is to help user improve.

${modeInstruction}

Return ONLY valid JSON with this exact structure:
{
  "corrected_sentences": [
    {
      "original": "...",
      "corrected": "...",
      "error_type": "grammar|vocabulary|preposition|article|other",
      "explanation": "...(explain in Chinese for clarity)",
      "is_common_for_chinese_speakers": true
    }
  ],
  "polished_sentences": [
    "First sentence of polished version.",
    "Second sentence.",
    "Each sentence is a separate array item."
  ],
  "chunks": [
    {
      "id": "any-unique-id",
      "chunk": "the exact phrase",
      "usage_note": "...(in Chinese)",
      "examples": [
        { "text": "Example sentence 1." },
        { "text": "Example sentence 2." }
      ]
    }
  ]
}

Select 3-5 chunks. Choose phrases with high transfer value — ones the user can reuse in many contexts.
If the user's transcript is already perfect, return an empty corrected_sentences array.
Do not return any text outside the JSON object. Do not wrap the JSON in markdown code fences.`;
}

const FOLLOWUP_SYSTEM_PROMPT = `You are an English language coach. The user is a native Chinese speaker learning English. You have just analyzed their spoken description of a photo and given them corrections, a polished version, and reusable phrases.

Now they may ask follow-up questions about the photo, their English, the corrections, or anything related to learning. Reply in a friendly, encouraging tone. Use English for examples and key terms; use Chinese (Simplified) for explanations so the user understands clearly. Keep replies concise — usually 2-5 sentences.

Formatting: the client renders Markdown, so feel free to use **bold** for emphasis on key terms, *italic* for example sentences, hyphen bullet lists for choices or contrasts, and \`code spans\` for individual words being discussed. Do not wrap the whole reply in a code block. Do not return JSON.`;

export interface AnalysisResult {
  corrected_sentences: CorrectedSentence[];
  polished_sentences: string[];
  chunks: Chunk[];
}

export type AnalyzeMode = 'polish' | 'expand';

export interface AnalyzeInput {
  /** Local file:// URI of the photo (use the 200x200 thumbnail to save tokens). */
  photoUri: string;
  /** Whisper transcript of the user's recording. */
  transcript: string;
  /**
   * 'polish' (default): faithful rewrite of what the user said.
   * 'expand': treat the user's words as the opening of a longer ~60s monologue.
   */
  mode?: AnalyzeMode;
}

export class MimoError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'MimoError';
  }
}

export async function analyzeSession(input: AnalyzeInput): Promise<AnalysisResult> {
  const base64 = await new File(input.photoUri).base64();
  const dataUri = `data:image/jpeg;base64,${base64}`;

  const body = {
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: buildSystemPrompt(input.mode ?? 'polish'),
      },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: dataUri },
          },
          {
            type: 'text',
            text: `Here is my spoken description of the photo:\n\n${input.transcript}`,
          },
        ],
      },
    ],
    // MiMo is a reasoning model — it spends 200-2000+ tokens on
    // hidden reasoning before emitting the JSON, all counted against
    // this budget. 4096 was getting truncated on multi-sentence
    // transcripts; 12288 leaves comfortable headroom even for a
    // 10-sentence "expand" mode response.
    max_completion_tokens: 12288,
    temperature: 0.4,
  };

  let json: MimoChatResponse;
  try {
    json = await backendRequest<MimoChatResponse>('POST', '/api/analyze', body);
  } catch (e) {
    throw new MimoError(
      e instanceof Error ? e.message : `MiMo request failed: ${String(e)}`
    );
  }

  const content = json?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new MimoError(
      `MiMo response missing content. Full response: ${JSON.stringify(json).slice(0, 500)}`
    );
  }

  return parseAnalysisJson(content);
}

interface MimoChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
      reasoning_content?: string;
    };
  }>;
}

function parseAnalysisJson(raw: string): AnalysisResult {
  const stripped = stripCodeFence(raw.trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    throw new MimoError(
      `Failed to parse MiMo JSON output: ${(e as Error).message}\n--- raw ---\n${raw.slice(0, 500)}`
    );
  }

  if (!isAnalysisShape(parsed)) {
    throw new MimoError(
      `MiMo JSON did not match expected shape. Got: ${JSON.stringify(parsed).slice(0, 500)}`
    );
  }

  return parsed;
}

function stripCodeFence(s: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  return match ? match[1] : s;
}

function isAnalysisShape(v: unknown): v is AnalysisResult {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    Array.isArray(o.corrected_sentences) &&
    Array.isArray(o.polished_sentences) &&
    Array.isArray(o.chunks) &&
    o.polished_sentences.every((x) => typeof x === 'string')
  );
}

export interface FollowUpInput {
  /** Local file:// URI of the same photo used for the original analysis. */
  photoUri: string;
  /** Original Whisper transcript. */
  transcript: string;
  /** First-pass analysis (gets serialized as the assistant's first message). */
  analysis: AnalysisResult;
  /** Follow-up message history so far (alternating user/assistant). */
  history: ChatMessage[];
  /** The new question the user just typed. */
  question: string;
}

export async function followUpChat(input: FollowUpInput): Promise<string> {
  const base64 = await new File(input.photoUri).base64();
  const dataUri = `data:image/jpeg;base64,${base64}`;

  const messages: object[] = [
    { role: 'system', content: FOLLOWUP_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: dataUri } },
        {
          type: 'text',
          text: `Here is what I said about this photo:\n\n${input.transcript}`,
        },
      ],
    },
    { role: 'assistant', content: formatAnalysisAsMarkdown(input.analysis) },
    ...input.history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: input.question },
  ];

  const body = {
    model: MODEL,
    messages,
    // Same reasoning budget concern as analyzeSession (see note
    // there). 4096 is enough for a chatty paragraph-length follow-up
    // reply plus reasoning overhead.
    max_completion_tokens: 4096,
    temperature: 0.5,
  };

  let json: MimoChatResponse;
  try {
    json = await backendRequest<MimoChatResponse>('POST', '/api/analyze', body);
  } catch (e) {
    throw new MimoError(
      e instanceof Error ? e.message : `MiMo follow-up failed: ${String(e)}`
    );
  }

  const content = json?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new MimoError(
      `MiMo follow-up missing content. Full response: ${JSON.stringify(json).slice(0, 500)}`
    );
  }
  return content.trim();
}

function formatAnalysisAsMarkdown(a: AnalysisResult): string {
  const parts: string[] = [];
  if (a.corrected_sentences.length > 0) {
    parts.push('Corrections:');
    a.corrected_sentences.forEach((c) => {
      parts.push(
        `- "${c.original}" → "${c.corrected}" (${c.error_type})${c.explanation ? ' — ' + c.explanation : ''}`
      );
    });
  } else {
    parts.push('No corrections — the user spoke accurately.');
  }
  parts.push('');
  parts.push(`Polished version: ${a.polished_sentences.join(' ')}`);
  if (a.chunks.length > 0) {
    parts.push('');
    parts.push('Useful chunks:');
    a.chunks.forEach((chunk) => {
      parts.push(
        `- "${chunk.chunk}"${chunk.usage_note ? ' — ' + chunk.usage_note : ''}`
      );
    });
  }
  return parts.join('\n');
}
