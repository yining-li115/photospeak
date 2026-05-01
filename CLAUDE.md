# PhotoSpeak — CLAUDE.md

This file gives you everything you need to implement this project. Read it fully before writing any code.

---

## What This App Does

PhotoSpeak is a mobile English speaking practice app. Every day, the user picks a photo from their phone, records ~1 minute of English describing it, and the app automatically:
1. Transcribes the recording
2. Sends photo + transcript to an LLM for correction, polishing, and chunk extraction
3. Lets the user review results and chat with AI in a session interface
4. On user confirmation, generates a podcast-style audio and creates SRS flashcards

The goal is a seamless, zero-friction daily learning loop.

---

## Tech Stack

| Layer | Choice | Notes |
|-------|--------|-------|
| Mobile framework | React Native + Expo | iOS + Android, one codebase |
| Audio recording | expo-av | Cross-platform |
| Photo library access | expo-image-picker | Cross-platform |
| Pipeline framework | LangGraph (JS) | Linear pipeline, node-level retry |
| STT | OpenAI Whisper API | Best accuracy for non-native accents |
| LLM analysis | Claude API (claude-sonnet-4-20250514) | Vision + language, structured JSON output |
| TTS | ElevenLabs API | Per-sentence audio files |
| SRS algorithm | FSRS | Modern spaced repetition |
| Local storage | expo-sqlite + expo-file-system | Offline-first |
| Backend (early stage) | None — client calls APIs directly | Keep it simple |

---

## Project Structure

```
photospeak/
├── app/                        # Expo Router file-based routing
│   ├── (tabs)/
│   │   ├── sessions/
│   │   │   ├── index.tsx       # Session list + "+" new session button
│   │   │   └── [id].tsx        # Session detail (chatbot view)
│   │   ├── listening/
│   │   │   ├── index.tsx       # Podcast list
│   │   │   └── [id].tsx        # Player screen
│   │   ├── cards/
│   │   │   └── index.tsx       # SRS review screen
│   │   └── home/
│   │       └── index.tsx       # Dashboard (streak, stats)
│   └── _layout.tsx             # Root layout with bottom tab nav
│
├── src/
│   ├── pipeline/               # LangGraph pipeline
│   │   ├── nodes/
│   │   │   ├── transcribe.ts   # STT node (Whisper)
│   │   │   ├── analyze.ts      # LLM node (Claude)
│   │   │   └── synthesize.ts   # TTS node (ElevenLabs)
│   │   ├── state.ts            # Pipeline state type definition
│   │   └── graph.ts            # LangGraph graph assembly
│   │
│   ├── api/                    # External API clients
│   │   ├── whisper.ts
│   │   ├── claude.ts
│   │   └── elevenlabs.ts
│   │
│   ├── db/                     # SQLite database layer
│   │   ├── schema.ts           # Table definitions
│   │   ├── sessions.ts         # Session CRUD
│   │   ├── cards.ts            # SRS card CRUD
│   │   └── stats.ts            # Streak / listening time queries
│   │
│   ├── srs/
│   │   └── fsrs.ts             # FSRS algorithm implementation
│   │
│   ├── hooks/                  # Custom React hooks
│   │   ├── useAudioRecorder.ts
│   │   ├── useAudioPlayer.ts
│   │   └── useSRSReview.ts
│   │
│   └── types/
│       └── index.ts            # Shared TypeScript types
│
├── assets/
├── .env                        # API keys (never commit)
├── CLAUDE.md                   # This file
└── PRD.md                      # Full product requirements
```

---

## Core Data Types

```typescript
// src/types/index.ts

export interface Session {
  id: string
  created_at: string
  photo_uri: string                  // local path to photo
  photo_thumbnail_uri: string        // resized thumbnail
  recording_uri: string              // original recording
  transcript: string                 // Whisper output
  corrected_sentences: CorrectedSentence[]
  polished_sentences: string[]       // per-sentence, maps to audio files
  chunks: Chunk[]
  chat_history: ChatMessage[]        // full AI chat log
  podcast_generated: boolean
  cards_generated: boolean
}

export interface CorrectedSentence {
  original: string
  corrected: string
  error_type: 'grammar' | 'vocabulary' | 'preposition' | 'article' | 'other'
  explanation: string
  is_common_for_chinese_speakers: boolean
}

export interface Chunk {
  id: string
  chunk: string                      // e.g. "captures a lively scene"
  usage_note: string
  examples: ChunkExample[]
}

export interface ChunkExample {
  text: string
  audio_uri: string                  // local path to TTS audio
}

export interface Card {
  id: string
  chunk_id: string
  chunk: string
  usage_note: string
  examples: ChunkExample[]
  photo_thumbnail_uri: string
  source_session_id: string
  created_at: string
  next_review_at: string
  stability: number                  // FSRS parameter
  difficulty: number                 // FSRS parameter
  review_history: ReviewRecord[]
}

export interface ReviewRecord {
  date: string
  rating: 1 | 2 | 3 | 4             // FSRS: Again / Hard / Good / Easy
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}
```

---

## Pipeline (LangGraph)

The pipeline is linear and deterministic. Each node is independent and can be retried individually on failure.

### State definition

```typescript
// src/pipeline/state.ts

export interface PipelineState {
  // Inputs
  photo_base64: string
  recording_uri: string

  // Node outputs
  transcript?: string
  analysis?: {
    corrected_sentences: CorrectedSentence[]
    polished_sentences: string[]
    chunks: Chunk[]
  }
  sentence_audio_uris?: string[]     // one per polished sentence
  chunk_example_audio_uris?: string[][] // [chunk_index][example_index]

  // Error tracking
  errors: Record<string, string>
}
```

### Node: transcribe.ts (Whisper)

```typescript
// Sends audio file to Whisper API
// Returns: transcript string
// On failure: set errors.transcribe, do not throw
```

### Node: analyze.ts (Claude)

```typescript
// Sends photo (base64) + transcript to Claude
// System prompt specifies: user is a Chinese native speaker
// Returns structured JSON matching analysis type above
// IMPORTANT: polished_sentences must be an array of individual sentences
// Each sentence becomes one audio file — do not merge them
```

### Node: synthesize.ts (ElevenLabs)

```typescript
// Called ONLY after user clicks "Confirm Generate"
// Generates one audio file per polished sentence
// Also generates audio for each chunk example sentence
// Saves all files to expo-file-system, stores paths in state
// Use a single fixed voice ID across all generations (store in .env)
```

### Graph assembly

```typescript
// src/pipeline/graph.ts
// Nodes run in sequence: transcribe → analyze
// synthesize runs separately, triggered by user confirmation
// Use LangGraph StateGraph with typed state
```

---

## API Clients

### Claude (src/api/claude.ts)

Model: `claude-sonnet-4-20250514`

System prompt template:
```
You are an English language coach. The user is a native Chinese speaker learning English.
Analyze their spoken English description of a photo.

Return ONLY valid JSON with this exact structure:
{
  "corrected_sentences": [
    {
      "original": "...",
      "corrected": "...",
      "error_type": "grammar|vocabulary|preposition|article|other",
      "explanation": "...(explain in Chinese for clarity)",
      "is_common_for_chinese_speakers": true|false
    }
  ],
  "polished_sentences": [
    "First sentence of polished version.",
    "Second sentence.",
    "Each sentence is a separate array item."
  ],
  "chunks": [
    {
      "id": "uuid",
      "chunk": "the exact phrase",
      "usage_note": "...(in Chinese)",
      "examples": [
        { "text": "Example sentence 1.", "audio_uri": "" },
        { "text": "Example sentence 2.", "audio_uri": "" }
      ]
    }
  ]
}

Select 3-5 chunks. Choose phrases with high transfer value — ones the user can reuse in many contexts.
Do not return any text outside the JSON object.
```

User message format:
```
[image: base64 photo]
[user transcript]
```

For follow-up chat messages in the session: use standard multi-turn conversation format, appending the full chat history each time.

### Whisper (src/api/whisper.ts)

```typescript
// POST to https://api.openai.com/v1/audio/transcriptions
// model: "whisper-1"
// language: "en"
// response_format: "text"
```

### ElevenLabs (src/api/elevenlabs.ts)

```typescript
// POST to https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}
// model_id: "eleven_multilingual_v2"
// Save response (binary audio) to expo-file-system
// Return local file URI
```

---

## Database Schema (SQLite)

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  photo_uri TEXT NOT NULL,
  photo_thumbnail_uri TEXT NOT NULL,
  recording_uri TEXT NOT NULL,
  transcript TEXT,
  corrected_sentences TEXT,    -- JSON string
  polished_sentences TEXT,     -- JSON string (array)
  sentence_audio_uris TEXT,    -- JSON string (array of local paths)
  chunks TEXT,                 -- JSON string
  chat_history TEXT,           -- JSON string
  podcast_generated INTEGER DEFAULT 0,
  cards_generated INTEGER DEFAULT 0
);

CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  chunk_id TEXT NOT NULL,
  chunk TEXT NOT NULL,
  usage_note TEXT NOT NULL,
  examples TEXT NOT NULL,      -- JSON string
  photo_thumbnail_uri TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  next_review_at TEXT NOT NULL,
  stability REAL DEFAULT 0,
  difficulty REAL DEFAULT 0,
  review_history TEXT DEFAULT '[]'  -- JSON string
);

CREATE TABLE stats (
  date TEXT PRIMARY KEY,       -- YYYY-MM-DD
  session_count INTEGER DEFAULT 0,
  listening_seconds INTEGER DEFAULT 0,
  cards_reviewed INTEGER DEFAULT 0
);
```

JSON columns: always parse/stringify at the DB layer, expose typed objects everywhere else.

---

## UI Screens

### Bottom Tab Navigator
Order: **Sessions | Listening | Cards | Home**

### Sessions Tab
- List of past sessions, sorted newest first
- Each row: thumbnail + date + first chunk text
- Top right: "+" button → starts new session flow
- Tap a session → SessionDetail screen

### New Session Flow (inside SessionDetail, step-by-step)
1. Photo picker: two buttons — "Random" and "Choose"
2. After photo selected: show photo + hold-to-record button
3. After recording released: show "Transcribing..." → "Analyzing..." progress
4. Results appear as chat bubbles (AI message with corrections, polished version, chunks)
5. User can type follow-up questions — appends to chat, calls Claude with full history
6. "Confirm & Generate" button at bottom → triggers TTS synthesis pipeline
7. On completion: toast "Added to Listening Library · 3 cards created"

### Listening Tab
- List of sessions with generated podcasts
- Each row: thumbnail + date + duration
- Tap → Player screen
  - Full polished text with sentence-level highlight sync
  - Tap any sentence → that sentence loops
  - Speed selector: 0.75x / 1x / 1.25x
  - "Original Recording" toggle to switch audio source

### Cards Tab
- Daily review queue driven by FSRS next_review_at
- Card flip animation: front (chunk + thumbnail) → back (usage note + examples + audio)
- Rating buttons: Again / Hard / Good / Easy (maps to FSRS ratings 1-4)
- Progress bar showing X / total cards remaining today

### Home Tab (Dashboard)
- Current streak (consecutive days with at least one session)
- Total listening time this week / all time
- Total cards created / mastered
- Cards reviewed today / due today

---

## Environment Variables

```
# .env
EXPO_PUBLIC_OPENAI_API_KEY=
EXPO_PUBLIC_ANTHROPIC_API_KEY=
EXPO_PUBLIC_ELEVENLABS_API_KEY=
EXPO_PUBLIC_ELEVENLABS_VOICE_ID=     # pick one voice, use it consistently
```

Never hardcode API keys. Never commit .env.

---

## Implementation Order

Build in this sequence — each phase is independently testable:

**Phase 1 — Core Pipeline**
1. Set up Expo project with file-based routing, bottom tabs
2. SQLite schema + CRUD layer
3. Photo picker (random + manual)
4. Audio recording with expo-av
5. Whisper transcription
6. Claude analysis with structured JSON output
7. Display results in chat-style UI
8. Follow-up chat (multi-turn with Claude)

**Phase 2 — Generate & Play**
9. ElevenLabs TTS per sentence, save to file system
10. "Confirm Generate" flow → podcast + cards created
11. Audio player with sentence highlight sync + single-sentence loop
12. Speed control

**Phase 3 — SRS + Stats**
13. FSRS algorithm
14. Daily card review UI
15. Stats tracking (streak, listening time, card counts)
16. Daily push notification for card review

---

## Key Decisions & Constraints

- **Per-sentence audio files**: ElevenLabs generates one file per sentence. This makes single-sentence looping trivial — just replay the file. No timeline scrubbing needed.
- **Confirm before TTS**: TTS runs only after user confirms. This avoids wasting API cost on sessions the user abandons mid-way.
- **Fixed TTS voice**: Use one voice ID for all generations. Users calibrate to a single voice over time — better for learning.
- **Offline-first storage**: All audio files and data live on device. Cloud sync is out of scope for now.
- **No backend (early stage)**: API keys are in the client for now. Add a backend before public launch to avoid key exposure.
- **Chat history**: Always send the full session chat history to Claude for follow-up questions. Claude has no memory between calls.
- **Photo thumbnail**: Resize to ~200x200px before storing and before sending to Claude. Full-res photos are only used for display.

---

## Common Pitfalls to Avoid

- Do not merge polished sentences into one string before TTS — keep them as an array
- Do not call TTS during the analysis step — only after user confirms
- Do not store audio files in the SQLite DB — store file paths only, files go in expo-file-system
- Do not expose API keys in any log output
- When calling Claude for follow-up chat, always include the original photo and the full message history
- FSRS `next_review_at` must be stored as ISO string and queried correctly for daily due cards
