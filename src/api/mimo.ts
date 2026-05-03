import { File } from 'expo-file-system';
import type { ChatMessage, Chunk, CorrectedSentence } from '../types';

const ENDPOINT = 'https://api.xiaomimimo.com/v1/chat/completions';
const MODEL = 'mimo-v2.5';

const SYSTEM_PROMPT = `You are an English language coach. The user is a native Chinese speaker learning English. Analyze their spoken English description of a photo. Your job is to help user improve.

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

const FOLLOWUP_SYSTEM_PROMPT = `You are an English language coach. The user is a native Chinese speaker learning English. You have just analyzed their spoken description of a photo and given them corrections, a polished version, and reusable phrases.

Now they may ask follow-up questions about the photo, their English, the corrections, or anything related to learning. Reply in a friendly, encouraging tone. Use English for examples and key terms; use Chinese (Simplified) for explanations so the user understands clearly. Keep replies concise — usually 2-5 sentences. Do not return JSON; reply in natural prose.`;

export interface AnalysisResult {
  corrected_sentences: CorrectedSentence[];
  polished_sentences: string[];
  chunks: Chunk[];
}

export interface AnalyzeInput {
  /** Local file:// URI of the photo (use the 200x200 thumbnail to save tokens). */
  photoUri: string;
  /** Whisper transcript of the user's recording. */
  transcript: string;
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
  const apiKey = process.env.EXPO_PUBLIC_MIMO_API_KEY;
  if (!apiKey) {
    throw new MimoError(
      'EXPO_PUBLIC_MIMO_API_KEY is not set. Add it to your .env file.'
    );
  }

  const base64 = await new File(input.photoUri).base64();
  const dataUri = `data:image/jpeg;base64,${base64}`;

  const body = {
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: SYSTEM_PROMPT,
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
    max_completion_tokens: 4096,
    temperature: 0.4,
  };

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await safeReadText(response);
    throw new MimoError(
      `MiMo request failed (${response.status}): ${errBody}`,
      response.status
    );
  }

  const json = (await response.json()) as MimoChatResponse;
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

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<no body>';
  }
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
  const apiKey = process.env.EXPO_PUBLIC_MIMO_API_KEY;
  if (!apiKey) {
    throw new MimoError(
      'EXPO_PUBLIC_MIMO_API_KEY is not set. Add it to your .env file.'
    );
  }

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
    max_completion_tokens: 1024,
    temperature: 0.5,
  };

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await safeReadText(response);
    throw new MimoError(
      `MiMo follow-up failed (${response.status}): ${errBody}`,
      response.status
    );
  }

  const json = (await response.json()) as MimoChatResponse;
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
