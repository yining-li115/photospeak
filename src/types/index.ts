export interface Session {
  id: string;
  created_at: string;
  photo_uri: string;
  photo_thumbnail_uri: string;
  recording_uri: string;
  transcript: string;
  corrected_sentences: CorrectedSentence[];
  polished_sentences: string[];
  sentence_audio_uris: string[];
  chunks: Chunk[];
  chat_history: ChatMessage[];
  podcast_generated: boolean;
  cards_generated: boolean;
}

export interface CorrectedSentence {
  original: string;
  corrected: string;
  error_type: 'grammar' | 'vocabulary' | 'preposition' | 'article' | 'other';
  explanation: string;
  is_common_for_chinese_speakers: boolean;
}

export interface Chunk {
  id: string;
  chunk: string;
  usage_note: string;
  examples: ChunkExample[];
}

export interface ChunkExample {
  text: string;
  /** Filled by Step 9 generate if we synthesize per-example audio.
   *  Cards UI no longer plays these, so it's optional now and new
   *  generates leave it empty. */
  audio_uri?: string;
}

export interface Card {
  id: string;
  chunk_id: string;
  chunk: string;
  usage_note: string;
  examples: ChunkExample[];
  photo_thumbnail_uri: string;
  source_session_id: string;
  created_at: string;
  next_review_at: string;
  stability: number;
  difficulty: number;
  review_history: ReviewRecord[];
}

export interface ReviewRecord {
  date: string;
  rating: 1 | 2 | 3 | 4;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface DailyStats {
  date: string;
  session_count: number;
  listening_seconds: number;
  cards_reviewed: number;
}
