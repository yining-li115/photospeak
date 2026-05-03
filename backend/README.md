# PhotoSpeak Backend

A tiny Cloudflare Worker that proxies the mobile app's calls to MiMo and Aliyun
DashScope. The point: **API keys never ship inside the iOS / Android binary**.

> Status: scaffolding only. The mobile app is **still calling MiMo / DashScope
> directly** — switching it over is a follow-up PR. Once you've deployed this
> Worker and confirmed the endpoints respond, we'll migrate `src/api/*.ts` one
> client at a time so playback / analyze / TTS keep working through the cut-over.

## Architecture

```
[ Mobile app ]
      │  Authorization: Bearer <APP_SHARED_TOKEN>
      ▼
[ Cloudflare Worker (this) ]
      │  upstream credentials are stored as Worker Secrets
      ▼
[ MiMo / DashScope ]
```

Endpoints (all require `Authorization: Bearer <APP_SHARED_TOKEN>`):

| Method | Path             | Forwards to                                                            |
| ------ | ---------------- | ---------------------------------------------------------------------- |
| POST   | `/api/transcribe`| DashScope `services/aigc/multimodal-generation/generation` (qwen3-asr) |
| POST   | `/api/analyze`   | MiMo `chat/completions` (mimo-v2.5 image+text or follow-up chat)       |
| POST   | `/api/tts`       | MiMo `chat/completions` (mimo-v2.5-tts)                                |

Plus public (no-auth) liveness probes:

- `GET /` — `"PhotoSpeak API · ok"`
- `GET /health` — JSON `{ status: "ok", deployedAt: "..." }`

## One-time setup

### 1. Install dependencies

```bash
cd backend
npm install
```

### 2. Cloudflare account

If you don't have one:

```bash
npx wrangler login
```

Opens a browser, sign up / sign in (free tier is plenty for testing — 100k
requests/day). Workers + a custom subdomain are free.

### 3. Local dev secrets

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars:
#   MIMO_API_KEY=<your MiMo key>
#   DASHSCOPE_API_KEY=<your Aliyun DashScope key>
#   APP_SHARED_TOKEN=<a long random string you make up>
```

Pick `APP_SHARED_TOKEN` like a password — long, random, unique. Example:

```bash
openssl rand -hex 32
```

The mobile app will send this token in `Authorization: Bearer <token>`.

### 4. Run locally

```bash
npm run dev
```

Wrangler starts a local Worker on `http://localhost:8787`. Test:

```bash
curl http://localhost:8787/health
# → {"status":"ok","deployedAt":"..."}

# With auth:
TOKEN="<whatever you put in .dev.vars>"
curl -X POST http://localhost:8787/api/analyze \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"mimo-v2.5","messages":[{"role":"user","content":"Hello"}]}'
```

## Deploying to production

### 5. Set production secrets

```bash
npx wrangler secret put MIMO_API_KEY
# (paste key when prompted)

npx wrangler secret put DASHSCOPE_API_KEY
npx wrangler secret put APP_SHARED_TOKEN
```

### 6. Deploy

```bash
npm run deploy
```

You'll get a URL like `https://photospeak-api.<your-subdomain>.workers.dev`.

Test it the same way:

```bash
curl https://photospeak-api.<your-subdomain>.workers.dev/health
```

## What the mobile app needs (later)

Once this is live we'll set in the mobile `.env`:

```
EXPO_PUBLIC_API_BASE=https://photospeak-api.<your-subdomain>.workers.dev
EXPO_PUBLIC_API_TOKEN=<same APP_SHARED_TOKEN>
```

…and rewire `src/api/mimo.ts`, `src/api/mimo-tts.ts`, `src/api/aliyun-asr.ts`
to point at the Worker instead of MiMo / DashScope directly.

The MiMo / DashScope keys then come **out** of the mobile `.env` entirely —
they never leave the Worker's secret store.

## What's not here yet (planned)

- **Real per-user auth.** Right now `APP_SHARED_TOKEN` is a single shared
  secret — anyone who has it can hit your Worker. Step 2 is to add user
  signup/login (Cloudflare D1 + simple email+password or magic link), issue
  per-user JWTs, and rate-limit per user.
- **Usage logging.** Once we have users we should log who hit which endpoint
  and how many tokens they spent so we can spot abuse.
- **Quota / rate limiting.** Cloudflare has built-in rate limit rules; easier
  to wire after auth is in.

## Operational notes

- `npx wrangler tail` streams live logs from the deployed Worker — useful for
  watching upstream errors without leaving the terminal.
- `npx wrangler secret list` shows which secrets are set (not their values).
- Free tier limits: 100k requests/day, 10ms CPU per request. The proxy is
  basically `fetch → fetch`, so we're nowhere near 10ms.
