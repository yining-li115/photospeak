# PhotoSpeak Backend

Node.js (Hono) proxy that fronts MiMo and Aliyun DashScope so API keys never
ship inside the iOS / Android binary. Designed to run on a small Aliyun
Lightweight Application Server in mainland China — same network as the
upstreams it proxies, low latency, no GFW round-trip.

> Status: live. The mobile app routes all MiMo / DashScope calls
> through this proxy. Auth is per-user JWT issued by `/auth/*` (Apple
> Sign-In or SMS code). The legacy `APP_SHARED_TOKEN` shared-bearer
> path still exists in `requireAuth` for historical IPA/APK builds but
> is being sunsetted — see `docs/optimization.md` S1.

## Architecture

```
[ Mobile app ]
      │  Authorization: Bearer <per-user JWT>     (current)
      │  Authorization: Bearer <APP_SHARED_TOKEN> (legacy, sunsetting)
      ▼
[ Aliyun Lightweight Server (Node.js + Hono via PM2) ]
      │  upstream credentials live in the host environment
      ▼
[ MiMo / DashScope ]
```

Endpoints (all require `Authorization: Bearer <JWT>`; legacy shared
token still accepted for old builds):

| Method | Path             | Forwards to                                                            |
| ------ | ---------------- | ---------------------------------------------------------------------- |
| POST   | `/api/transcribe`| DashScope `services/aigc/multimodal-generation/generation` (qwen3-asr) |
| POST   | `/api/analyze`   | MiMo `chat/completions` (mimo-v2.5 image+text or follow-up chat)       |
| POST   | `/api/tts`       | MiMo `chat/completions` (mimo-v2.5-tts)                                |

Plus public (no-auth) liveness probes:

- `GET /` — `"PhotoSpeak API · ok"`
- `GET /health` — JSON `{ status: "ok", deployedAt: "..." }`

---

## Local development

```bash
cd backend
npm install
cp .env.example .env
# Edit .env:
#   MIMO_API_KEY=...
#   DASHSCOPE_API_KEY=...
#   APP_SHARED_TOKEN=$(openssl rand -hex 32)
npm run dev
```

That starts `tsx watch` on `:3000`. Test:

```bash
curl http://localhost:3000/health
# → {"status":"ok","deployedAt":"..."}

TOKEN=$(grep APP_SHARED_TOKEN .env | cut -d= -f2)
curl -X POST http://localhost:3000/api/analyze \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"mimo-v2.5","messages":[{"role":"user","content":"Hello"}]}'
# → MiMo's actual response
```

---

## Deploying to Aliyun Lightweight Server

### 0. Buy a server

- 阿里云控制台 → 轻量应用服务器 → 套餐随便选 1C2G 起步（约 ¥99/年的活动很常见）
- 镜像选 **Ubuntu 22.04**
- 创建后记下公网 IP

### 1. Buy a domain (optional but recommended)

If you want HTTPS (you do — iOS App Transport Security blocks plain HTTP by
default), you need a domain. Cheap options:

- 阿里云域名注册 .top / .xyz / .cn — 约 ¥10-30/year
- Add an A record pointing to your server's public IP

If you skip this you can use `https://<ip>` with a self-signed cert, but iOS
will refuse to connect unless you whitelist the host in `app.json` (`ios.
infoPlist.NSAppTransportSecurity.NSExceptionDomains`).

### 2. Aliyun firewall: open port 80 + 443

In the lightweight server console → 防火墙 → add rules:

- TCP 80 (HTTP, for Let's Encrypt validation)
- TCP 443 (HTTPS)

### 3. SSH in and install Node.js + PM2 + nginx + certbot

```bash
ssh root@<your-server-ip>

# Node.js 20 via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20
node -v   # v20.x

# PM2 process manager
npm install -g pm2

# nginx + certbot for HTTPS
apt update
apt install -y nginx certbot python3-certbot-nginx
```

> **大陆机房 GFW 兜底**：`raw.githubusercontent.com` 在国内服务器上经常被掐。如果上面 `curl ... nvm` 那步卡住，改用 Gitee 镜像 + npmmirror：
>
> ```bash
> curl -o- https://gitee.com/mirrors/nvm/raw/v0.40.1/install.sh | bash
> source ~/.bashrc
> export NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node
> nvm install 20
> nvm use 20
> ```

### 4. Upload the backend code

Easiest: `git clone` the whole PhotoSpeak repo and `cd backend`.

```bash
cd /opt
git clone <your-repo-url> photospeak
cd photospeak/backend
npm install
npm run build         # → dist/index.js
```

### 5. Create the production .env

```bash
cd /opt/photospeak/backend       # or /root/photospeak/backend if you cloned to /root
cp .env.example .env
nano .env
```

Fill in the three values. For `APP_SHARED_TOKEN`, generate a long random
string and **save the value somewhere** — you'll paste it into the mobile
`.env` later.

```bash
openssl rand -hex 32   # use the output as APP_SHARED_TOKEN
```

`.env` is gitignored, so it stays on this server only. The app loads it via
`import 'dotenv/config'` at startup.

### 6. Start under PM2

```bash
cd /opt/photospeak/backend
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup        # prints a sudo command — run it
```

Verify:

```bash
curl http://localhost:3000/health
# → {"status":"ok",...}
```

### 7. nginx reverse proxy

```bash
nano /etc/nginx/sites-available/photospeak
```

Paste (replace `api.your-domain.com`):

```nginx
server {
    listen 80;
    server_name api.your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # MiMo TTS responses contain large base64 audio — let nginx through.
        proxy_read_timeout 120s;
        client_max_body_size 50M;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/photospeak /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx
```

### 8. HTTPS via Let's Encrypt

```bash
certbot --nginx -d api.your-domain.com
# Answer the prompts. Certbot edits the nginx config to add SSL +
# auto-renewal.
```

Verify:

```bash
curl https://api.your-domain.com/health
# → {"status":"ok",...}
```

---

## Operations

```bash
pm2 status              # is it running
pm2 logs photospeak-api # tail logs
pm2 restart photospeak-api
pm2 stop photospeak-api
```

### Deploying a code change

Use the deploy script — it auto-rolls-back on failure so you can't end
up half-deployed:

```bash
cd /opt/photospeak/backend
./scripts/deploy.sh
```

What it does, in order, with auto-rollback if anything fails:

1. Records the prior commit (the rollback target).
2. `git pull --ff-only` to `origin/main`.
3. Tags the new commit `deploy-YYYYMMDD-HHMMSS` so you can always
   `git checkout deploy-2026-05-09-1430` later.
4. `npm install --omit=dev`, `npm run build`, `npm run db:migrate`.
5. `pm2 reload photospeak-api --update-env`.
6. Runs `scripts/smoke-test.sh` against `localhost:3000` —
   `/health`, `/privacy`, and `/api/transcribe` (must 401 unauth'd).
7. If any of 4–6 fails, resets HEAD to the prior commit, rebuilds,
   reloads. PM2 ends up running the prior version, period.

Flags:
- `--skip-smoke` skip the post-deploy smoke test
- `--no-migrate` skip drizzle migrations (pure code change)

Smoke test alone (no deploy):

```bash
./scripts/smoke-test.sh
# or against a staging port:
./scripts/smoke-test.sh --base http://localhost:3001
```

### Database backups

A `pg_dump` cron is the cheapest disaster-recovery layer for the
self-hosted Postgres on the LAS. `scripts/backup.sh` writes
compressed dumps to `/var/backups/photospeak/` with 7-day retention.

One-time setup:

```bash
# 1. Backup directory the cron user can write to:
sudo mkdir -p /var/backups/photospeak
sudo chown $USER /var/backups/photospeak

# 2. Smoke-test a manual run (loads DATABASE_URL from backend/.env):
cd /opt/photospeak/backend
set -a && source .env && set +a && ./scripts/backup.sh

# 3. Install the cron:
crontab -e
# Add (4 AM UTC daily):
# 0 4 * * * cd /opt/photospeak/backend && set -a && . ./.env && set +a && ./scripts/backup.sh >> /var/log/photospeak-backup.log 2>&1
```

Restore from a dump:

```bash
gunzip -c /var/backups/photospeak/photospeak-YYYYMMDD-HHMMSS.dump.gz \
  | pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL"
```

Off-host upload (Aliyun OSS) is intentionally NOT here yet — until
that's wired up the dumps protect against migration mistakes /
accidental `DROP TABLE`, but not against a full LAS disk loss.
Roadmap item P3 / P12 (OSS plumbing) unlocks adding an `ossutil cp`
step at the end of `backup.sh`.

### Rolling back manually

If you suspect a deploy is bad and the auto-rollback didn't fire (e.g.
smoke test passed but real users see issues), pick the prior tag:

```bash
git tag --sort=-creatordate | head -5    # see recent deploy tags
git checkout deploy-2026-05-09-1430      # the one before the bad deploy
cd backend
npm run build
pm2 reload photospeak-api --update-env
```

---

## Mobile client config

```
EXPO_PUBLIC_API_BASE=https://api.your-domain.com
# EXPO_PUBLIC_API_TOKEN=  # ⚠️ deprecated — leave empty in new builds (S1)
```

`src/api/backend.ts` is the central HTTP wrapper for the proxy; it
reads JWT from `expo-secure-store` and refreshes on 401. Per-feature
clients (`mimo.ts`, `mimo-tts.ts`, `aliyun-asr.ts`) all call through it.

Every request also carries `X-Client-Version` and `X-Client-Platform`
so the server can correlate users to app versions when deciding when
to retire deprecated auth or API paths.

---

## Tech debt / roadmap

See [`../docs/optimization.md`](../docs/optimization.md) for the
prioritized list. Highlights for this codebase:

- 🔴 **S1** — Sunset `APP_SHARED_TOKEN`. Current step: middleware logs
  `mode: 'jwt' | 'legacy'` per request so we can watch the decay.
- 🔴 **S2** — `/api/*` is a verbatim passthrough. Add zod validation +
  body-size limit. New endpoints should route through the future LLM
  Gateway (P14), not copy the existing `fetch + passthrough` pattern.
- 🔴 **S3** — `cors()` is wide open; restrict origins.
- 🔴 **S4 / S5** — No `app.onError()` and no rate limiting yet.
- 🟡 **P2 / P14** — Synchronous proxy + no LLM Gateway abstraction.
  This is the next big architectural change before scaling further.
