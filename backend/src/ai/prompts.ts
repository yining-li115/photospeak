import type { AnalysisResult, AnalyzeRequest, TtsRequest } from './contracts.js';
import type { AiChatMessage } from './types.js';

const POLISH_INSTRUCTION = `Rewrite the transcript as a native English speaker would say it in casual conversation. Fix grammar, word choice, and phrasing, while preserving the speaker's meaning, length, and sentence structure. Do not add ideas or observations that are not in the transcript.`;

const EXPAND_INSTRUCTION = `Treat the transcript as the opening of a longer description. Build a natural roughly 60-second spoken monologue (about 8-12 sentences) that starts from what the speaker said and continues by describing the photo more fully. Keep corrected_sentences limited to words the speaker actually said.`;

function analysisSystemPrompt(mode: 'polish' | 'expand'): string {
  const modeInstruction =
    mode === 'expand' ? EXPAND_INSTRUCTION : POLISH_INSTRUCTION;
  return `You are an English-language coach for native Chinese speakers.

${modeInstruction}

Return only one valid JSON object with this exact shape:
{
  "corrected_sentences": [{
    "original": "...",
    "corrected": "...",
    "error_type": "grammar|vocabulary|preposition|article|other",
    "explanation": "Chinese explanation",
    "is_common_for_chinese_speakers": true
  }],
  "polished_sentences": ["One spoken sentence per item."],
  "chunks": [{
    "id": "unique-id",
    "chunk": "an exact multi-word phrase",
    "usage_note": "Chinese usage note",
    "examples": [{"text":"Example one."},{"text":"Example two."}]
  }]
}

Choose 3-5 reusable multi-word chunks from the polished version. Avoid proper nouns and photo-specific phrases. Each chunk must have exactly two examples in contexts different from the photo. Return an empty corrected_sentences array when no correction is needed. Do not use Markdown fences.`;
}

const FOLLOW_UP_SYSTEM_PROMPT = `You are an English-language coach for native Chinese speakers. Answer questions about the learner's photo, transcript, corrections, polished version, or reusable phrases. Use English for examples and key terms, Simplified Chinese for explanations, and a friendly concise tone. Usually answer in 2-5 sentences. Markdown is allowed. Refuse unrelated requests briefly and redirect to English learning.`;

function analysisAsContext(result: AnalysisResult): string {
  return JSON.stringify(result);
}

export function buildAnalyzeMessages(request: AnalyzeRequest): AiChatMessage[] {
  if (request.operation === 'session_analysis') {
    return [
      { role: 'system', content: analysisSystemPrompt(request.mode) },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: request.photo_data_url },
          },
          {
            type: 'text',
            text: `Here is the learner's spoken description:\n\n${request.transcript}`,
          },
        ],
      },
    ];
  }

  return [
    { role: 'system', content: FOLLOW_UP_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: request.photo_data_url },
        },
        {
          type: 'text',
          text: `The learner said:\n\n${request.transcript}`,
        },
      ],
    },
    { role: 'assistant', content: analysisAsContext(request.analysis) },
    ...request.history,
    { role: 'user', content: request.question },
  ];
}

const TTS_STYLE_INSTRUCTIONS: Record<TtsRequest['style'], string | null> = {
  neutral: null,
  warm: 'Read in a warm, natural, conversational style.',
  encouraging: 'Read in an encouraging English-coach style.',
  slow: 'Read clearly and slightly slowly for an English learner.',
};

export function buildTtsMessages(request: TtsRequest): AiChatMessage[] {
  const messages: AiChatMessage[] = [];
  const instruction = TTS_STYLE_INSTRUCTIONS[request.style];
  if (instruction) messages.push({ role: 'user', content: instruction });
  messages.push({ role: 'assistant', content: request.text });
  return messages;
}
