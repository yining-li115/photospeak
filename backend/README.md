# PhotoSpeak Backend

Node.js (Hono) proxy that fronts MiMo and Aliyun DashScope so API keys never
ship inside the iOS / Android binary. Designed to run on a small Aliyun
Lightweight Application Server in mainland China — same network as the
upstreams it proxies, low latency, no GFW round-trip.

> Status: scaffolding only. The mobile app still calls MiMo / DashScope
> directly. Once this is deployed and `curl` against `/health` works, we'll
> migrate `src/api/*.ts` one client at a time.

## Architecture

```
[ Mobile app ]
      │  Authorization: Bearer <APP_SHARED_TOKEN>
      ▼
[ Aliyun Lightweight Server (Node.js + Hono via PM2) ]
      │  upstream credentials live in the host environment
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

### 4. Upload the backend code

Easiest: `git clone` the whole PhotoSpeak repo and `cd backend`.

```bash
cd /opt
git clone <your-repo-url> photospeak
cd photospeak/backend
npm install
npm run build         # → dist/index.js
```

### 5. Set production secrets in the host environment

```bash
nano ~/.bashrc
# Append:
export PHOTOSPEAK_MIMO_API_KEY="..."
export PHOTOSPEAK_DASHSCOPE_API_KEY="..."
export PHOTOSPEAK_APP_SHARED_TOKEN="$(openssl rand -hex 32)"
# Save the APP_SHARED_TOKEN value somewhere — you'll paste it into
# the mobile .env later.

source ~/.bashrc
```

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

To deploy a code change:

```bash
cd /opt/photospeak
git pull
cd backend
npm install         # only if package.json changed
npm run build
pm2 reload photospeak-api    # zero-downtime
```

---

## What the mobile app needs (later)

Once this is live we'll set in the mobile `.env`:

```
EXPO_PUBLIC_API_BASE=https://api.your-domain.com
EXPO_PUBLIC_API_TOKEN=<same APP_SHARED_TOKEN>
```

…and rewire `src/api/mimo.ts`, `src/api/mimo-tts.ts`, `src/api/aliyun-asr.ts`
to point at the proxy instead of MiMo / DashScope directly. The MiMo /
DashScope keys then leave the mobile bundle entirely.

---

## What's not here yet (planned)

- **Real per-user auth.** `APP_SHARED_TOKEN` is a single shared secret —
  anyone who has it can hit your server. Phase 2 adds user signup/login,
  per-user JWTs, rate limiting.
- **Usage logging.** Once we have users we should log who hit which endpoint
  and how many tokens they spent so we can spot abuse.
