# PhotoSpeak — CLAUDE.md

This file gives you everything you need to work on this project. Read it fully before writing any code.

> **Roadmap & known tech debt:** see [`docs/optimization.md`](docs/optimization.md) for the current optimization plan, severity-tiered findings, and Phase ordering. Anything marked TODO there shouldn't be re-derived from this file — check the roadmap first.

---

## What This App Does

PhotoSpeak is a mobile English speaking practice app. Every day, the user picks a photo from their phone, records ~1 minute of English describing it, and the app automatically:
1. Transcribes the recording
2. Sends photo + transcript to an LLM for correction, polishing, and chunk extraction
3. Lets the user review results and chat with AI in a session interface
4. On user confirmation, generates per-sentence TTS audio and creates SRS flashcards

The goal is a seamless, zero-friction daily learning loop.

---

## Tech Stack

| Layer | Choice | Notes |
|-------|--------|-------|
| Mobile framework | React Native + Expo | iOS + Android, one codebase |
| Audio recording | expo-av | Cross-platform |
| Photo library access | expo-image-picker | Cross-platform |
| Pipeline orchestration | Plain async/await in `src/services/generate.ts` | No framework — linear flow, easy to debug |
| STT | Aliyun DashScope ASR (Qwen) **or** OpenAI Whisper (fallback) | Switchable via `EXPO_PUBLIC_STT_PROVIDER`. DashScope is the production path. |
| LLM analysis | MiMo (`api.xiaomimimo.com/v1/chat/completions`) | Vision + language, structured JSON output |
| TTS | MiMo TTS (same chat/completions endpoint, audio response) | Per-sentence, returns base64 |
| SRS algorithm | FSRS (`ts-fsrs`) | Modern spaced repetition |
| Local storage | expo-sqlite + expo-file-system | Offline-first; storage paths kept relative to documentDirectory |
| Backend | Node.js + Hono + PostgreSQL (Drizzle ORM) | Deployed on Aliyun ECS via PM2. Hosts auth + acts as proxy for upstream LLM/STT/TTS APIs. |
| Auth | Apple Sign-In + SMS code (Aliyun SMS), JWT access + refresh | Tokens stored in `expo-secure-store` |

---

## Project Structure

```
photospeak/
├── app/                            # Expo Router
│   ├── (auth)/
│   │   ├── welcome.tsx
│   │   ├── phone.tsx
│   │   └── verify.tsx
│   ├── (tabs)/
│   │   ├── sessions/{index,[id],_layout}.tsx
│   │   ├── listening/{index,[id],_layout}.tsx
│   │   ├── cards/{index,_layout}.tsx
│   │   └── home/{index,_layout}.tsx
│   ├── _layout.tsx
│   └── index.tsx                   # Routing root (auth gate)
│
├── src/
│   ├── api/                        # External API clients (production paths go via backend)
│   │   ├── backend.ts              # Central fetch wrapper: auth header, 401 → refresh → retry
│   │   ├── auth.ts                 # /auth/* client (apple, send-code, verify, refresh, me, logout)
│   │   ├── stt.ts                  # Dispatches to whisper.ts or aliyun-asr.ts based on EXPO_PUBLIC_STT_PROVIDER
│   │   ├── aliyun-asr.ts           # Calls backend /api/transcribe (DashScope passthrough)
│   │   ├── mimo.ts                 # Calls backend /api/analyze (MiMo passthrough) + chat follow-up
│   │   ├── mimo-tts.ts             # Calls backend /api/tts
│   │   └── whisper.ts              # ⚠️ Legacy direct-OpenAI fallback. Slated for removal (P10).
│   │
│   ├── services/                   # Domain orchestration (pipeline lives here, not in /api)
│   │   ├── generate.ts             # Confirm-Generate flow: TTS each sentence, persist, create cards
│   │   ├── queue.ts                # Build player queue from session(s)
│   │   └── delete.ts               # Soft delete + cascade cleanup
│   │
│   ├── context/
│   │   ├── auth.tsx                # AuthContext: token state, login/logout, app-launch refresh
│   │   └── player.tsx              # Audio player state
│   │
│   ├── db/                         # Local SQLite layer
│   │   ├── schema.ts
│   │   ├── sessions.ts
│   │   ├── cards.ts
│   │   └── stats.ts
│   │
│   ├── srs/
│   │   └── fsrs.ts                 # ts-fsrs wrapper
│   │
│   ├── storage/                    # File system helpers
│   │   ├── audio.ts
│   │   ├── photos.ts
│   │   ├── recordings.ts
│   │   ├── picker.ts
│   │   └── resolve.ts              # Resolves stored relative paths → absolute documentDirectory URIs
│   │
│   ├── hooks/{useAudioRecorder,useAudioPlayer,useSRSReview}.ts
│   ├── components/                 # App-specific components (separate from /components Expo template UI)
│   └── types/index.ts              # Shared TypeScript types
│
├── backend/                        # Hono + PostgreSQL backend
│   ├── src/
│   │   ├── index.ts                # App entry: CORS, auth routes, /api/* proxy routes
│   │   ├── auth/
│   │   │   ├── jwt.ts              # signToken / verifyToken (access + refresh)
│   │   │   ├── middleware.ts       # requireAuth (allows legacy shared token), requireUser (strict)
│   │   │   ├── apple.ts            # Apple Sign-In identity_token verification
│   │   │   └── sms.ts              # Aliyun SMS send + verify
│   │   ├── routes/auth.ts          # /auth/apple, /auth/send-code, /auth/verify, /auth/refresh, /auth/me, /auth/logout
│   │   ├── db/{client,schema,migrate}.ts
│   │   └── legal.ts                # /privacy + /terms HTML
│   ├── drizzle/                    # SQL migrations
│   ├── ecosystem.config.cjs        # PM2 config
│   └── README.md                   # Deploy + ops notes
│
├── docs/
│   ├── PhotoSpeak_PRD.md
│   └── optimization.md             # ⭐ Roadmap + tech debt
│
├── assets/
├── .env / .env.example             # Client env (never commit .env)
└── CLAUDE.md                       # This file
```

---

## Core Data Types

```typescript
// src/types/index.ts (canonical — do not duplicate elsewhere)

export interface Session {
  id: string
  created_at: string
  photo_uri: string                  // RELATIVE to documentDirectory
  photo_thumbnail_uri: string        // RELATIVE
  recording_uri: string              // RELATIVE
  transcript: string
  corrected_sentences: CorrectedSentence[]
  polished_sentences: string[]       // per-sentence; maps to sentence_audio_uris by index
  sentence_audio_uris: string[]      // RELATIVE
  chunks: Chunk[]
  chat_history: ChatMessage[]
  podcast_generated: boolean
  cards_generated: boolean
}

export interface CorrectedSentence {
  original: string
  corrected: string
  error_type: 'grammar' | 'vocabulary' | 'preposition' | 'article' | 'other'
  explanation: string                // in Chinese for clarity
  is_common_for_chinese_speakers: boolean
}

export interface Chunk {
  id: string
  chunk: string
  usage_note: string                 // in Chinese
  examples: ChunkExample[]
}

export interface ChunkExample {
  text: string
  audio_uri: string                  // RELATIVE; currently empty — see Key Decisions
}
```

**Storage path invariant**: all `*_uri` fields are stored *relative* to `FileSystem.documentDirectory`. iOS reinstalls / OTA updates change the absolute UUID prefix, which would break absolute paths. Always resolve via `src/storage/resolve.ts` at the read boundary.

---

## Pipeline (current architecture)

The pipeline is linear and lives in `src/services/generate.ts`. **No LangGraph or other framework** — plain async/await.

**Phase A — recording → analysis** (runs while user waits, in `app/(tabs)/sessions/[id].tsx`):
1. User picks photo + records audio → photo + recording stored locally with relative URIs
2. `src/api/stt.ts` → backend `/api/transcribe` → DashScope → transcript
3. `src/api/mimo.ts` → backend `/api/analyze` → MiMo → structured JSON (corrections + polished sentences + chunks)
4. UI displays results as chat bubbles. Follow-up questions: each call sends full chat history + photo back through `/api/analyze`.

**Phase B — confirm-generate** (runs only when user clicks "Confirm & Generate"):
1. `src/services/generate.ts` loops over `polished_sentences`, calls `mimo-tts.ts` → backend `/api/tts` for each
2. Each base64 audio response is written to file system via `src/storage/audio.ts`, returning a relative URI
3. Session row persisted via `src/db/sessions.ts` (with all relative URIs)
4. Cards created via `src/db/cards.ts` (one card per chunk)
5. Stats bumped via `src/db/stats.ts`

**Important constraints:**
- `polished_sentences` must remain an array — each item becomes one TTS audio file. Do **not** merge them.
- TTS runs **only after** user confirms — keeps cost down for abandoned sessions.
- Use a single fixed voice (server-side `MIMO_VOICE_ID`) for consistency.
- Chunk examples currently get **no audio** (text-only). The cards UI was simplified and per-example audio was dropped to save TTS calls. To reintroduce, add a second loop in `generate.ts`.

---

## Backend Contract

The backend has two roles:

**1. Auth service** (`/auth/*`):
- Apple Sign-In: `POST /auth/apple` with `identity_token`
- Phone: `POST /auth/send-code` → `POST /auth/verify` (Aliyun SMS)
- `POST /auth/refresh`, `GET /auth/me`, `POST /auth/logout`
- Returns `{ access_token, refresh_token, user }`. Access token short-TTL, refresh long. Refresh tokens tracked in `refresh_tokens` for revocation.

**2. Upstream proxy** (`/api/*`, all gated by `requireAuth`):
- `POST /api/transcribe` → DashScope ASR
- `POST /api/analyze` → MiMo chat completions
- `POST /api/tts` → MiMo TTS

The proxy currently passes the body through verbatim — no validation, no body-size limit. **This is a known weakness; see optimization.md S2 + P14 (LLM Gateway).** When adding new endpoints, do **not** continue the passthrough pattern — add zod validation and route through the LLM Gateway abstraction once it exists.

**Auth modes accepted by `/api/*`:**
- Per-user JWT (the long-term path)
- Legacy `APP_SHARED_TOKEN` bearer (still accepted for older client builds, scheduled for removal — see S1)

---

## Database

**Client-side (SQLite, `src/db/schema.ts`):**

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  photo_uri TEXT NOT NULL,            -- relative
  photo_thumbnail_uri TEXT NOT NULL,  -- relative
  recording_uri TEXT NOT NULL,        -- relative
  transcript TEXT,
  corrected_sentences TEXT,           -- JSON
  polished_sentences TEXT,            -- JSON array
  sentence_audio_uris TEXT,           -- JSON array of relative paths
  chunks TEXT,                        -- JSON
  chat_history TEXT,                  -- JSON
  podcast_generated INTEGER DEFAULT 0,
  cards_generated INTEGER DEFAULT 0
);

CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  chunk_id TEXT NOT NULL,
  chunk TEXT NOT NULL,
  usage_note TEXT NOT NULL,
  examples TEXT NOT NULL,             -- JSON
  photo_thumbnail_uri TEXT NOT NULL,  -- relative
  source_session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  next_review_at TEXT NOT NULL,
  stability REAL DEFAULT 0,
  difficulty REAL DEFAULT 0,
  review_history TEXT DEFAULT '[]'
);

CREATE TABLE stats (
  date TEXT PRIMARY KEY,              -- YYYY-MM-DD
  session_count INTEGER DEFAULT 0,
  listening_seconds INTEGER DEFAULT 0,
  cards_reviewed INTEGER DEFAULT 0
);
```

JSON columns: parse/stringify at the DB layer, expose typed objects everywhere else.

**Server-side (PostgreSQL via Drizzle, `backend/src/db/schema.ts`):**

Currently only `users` and `refresh_tokens`. Sessions / cards / stats live **only on the device**. Whether to sync them to the server is an open product decision — see optimization.md Q4.

---

## Environment Variables

**Client (`.env`, never commit):**
```
EXPO_PUBLIC_API_BASE=                # backend URL (currently HTTP IP, switching to https://api.dailyphotospeak.cn after ICP filing — S6)
EXPO_PUBLIC_API_TOKEN=               # ⚠️ Legacy shared token — do not use in new code (S1)
EXPO_PUBLIC_SENTRY_DSN=              # Optional; Sentry init is gated on this
EXPO_PUBLIC_STT_PROVIDER=            # 'whisper' | 'aliyun-qwen'
EXPO_PUBLIC_OPENAI_API_KEY=          # ⚠️ Only used by whisper.ts fallback. Slated for removal (P10).
EXPO_PUBLIC_WHISPER_ENDPOINT=        # Optional local Whisper server URL
```

**Backend (`backend/.env`, never commit):**
```
DATABASE_URL=
JWT_SECRET=                          # 32+ chars, no fallback
MIMO_API_KEY=
DASHSCOPE_API_KEY=
APP_SHARED_TOKEN=                    # Legacy, will be removed
APPLE_CLIENT_ID=                     # Apple Sign-In audience
ALIYUN_SMS_*                         # SMS credentials
```

Never hardcode keys. Never log them. Never commit `.env`. Never read `.env` files via tool calls — values land in conversation history and need rotation.

---

## Current State & Roadmap

The original three-phase build plan (Core Pipeline → Generate & Play → SRS + Stats) is largely **complete**. Auth was added later (Apple + phone). The system is in production with growing usage.

**For new work**, consult [`docs/optimization.md`](docs/optimization.md) — it lists everything currently broken or insufficient for scale, in priority order. Don't add features without first checking whether the surrounding area has open 🔴 / 🟡 items.

In-flight concerns to keep in mind (full list in roadmap):
- 🔴 Legacy `APP_SHARED_TOKEN` still accepted on `/api/*` (S1)
- 🔴 `/api/*` proxy has no input validation or body size limit (S2)
- 🔴 No global error handler in Hono (S4)
- 🔴 No rate limiting (S5)
- 🟡 Synchronous proxy model — must move to async queue + LLM Gateway before serving 1000 concurrent users (P2 + P14)

---

## Key Decisions & Constraints

- **Per-sentence audio files**: TTS generates one file per sentence. Single-sentence looping is just a replay — no timeline scrubbing.
- **Confirm before TTS**: TTS runs only after user confirms, avoiding wasted API cost on abandoned sessions.
- **Fixed TTS voice**: One voice ID across all generations. Users calibrate to a single voice over time.
- **Offline-first storage**: All audio files and session/card data live on device. Cloud sync is a future decision (Q4).
- **Backend is a thin proxy + auth**: Upstream API keys live server-side; the backend authenticates and forwards. The forward path is slated to grow into a proper LLM Gateway (P14).
- **Chat history**: Always send the full session chat history + photo to MiMo for follow-up questions. The model has no memory between calls.
- **Photo thumbnail**: Resize to ~200x200px before storing and before sending to MiMo. Full-res photos are only used for display.
- **Storage paths are relative**: see invariant note above. Always resolve via `src/storage/resolve.ts`.

---

## Common Pitfalls to Avoid

- Do not merge polished sentences into one string before TTS — keep them as an array.
- Do not call TTS during the analysis step — only after user confirms.
- Do not store audio files in SQLite — store relative paths only; bytes go in `expo-file-system`.
- Do not write absolute file URIs into the DB — always relative to documentDirectory.
- Do not expose API keys in any log output.
- Do not add new `/api/*` endpoints by copying the existing passthrough pattern (see Backend Contract above) — add validation, prefer routing through the future LLM Gateway.
- When calling MiMo for follow-up chat, always include the original photo and the full message history.
- FSRS `next_review_at` must be stored as ISO string and queried correctly for daily-due cards.
- Do not read `.env` files via tool calls — values land in conversation history and need rotation.
