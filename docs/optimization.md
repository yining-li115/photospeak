# PhotoSpeak 系统性优化清单

> 快照时间：2026-05-12
> 用途：用户量起来前的系统性优化路线图。每项都附文件位置和修复方向，按优先级排好，可逐项勾选推进。
> 命名规则：项目编号 (S1, P1, Q1...) 是稳定 ID，跨 Phase 引用时用编号。

---

## 🔄 进行中（in-flight）

| 项 | 当前阶段 | 下一步 / 阻塞 |
|----|---------|---------------|
| **S1** | Phase 2 观测期（2026-05-09 起）| 等 P1 监控接好后看 legacy 流量衰减；连续 7 天 < 1% 即可推进 Phase 3 删分支 |

跑完一项就把它从这表里挪走；新接手的项进来填上。

## ✅ 已完成

| 项 | 完成时间 | 备注 |
|----|---------|------|
| **STT streaming**（拆 P3 的一部分前置完成）| 2026-05-12 | 客户端直连 DashScope `paraformer-realtime-v2` WebSocket + backend 签短期 token；transcribe 路径上 backend 不再接触音频字节，停录到看见文本从 4–10s 降到 < 1s |
| **S2** · `/api/*` 加 zod 校验 + body 大小限制 | 2026-05-09 | 顺手做掉 Q2（routes 抽到 `routes/proxy.ts`）|
| **S3** · CORS 收紧 | 2026-05-09 | 直接移除 wildcard——mobile 不需要、公开 HTML 也用不上 |
| **S4** · 全局错误处理 | 2026-05-09 | Hono `onError` + 进程级 fatal handler；不 swallow，让 PM2 重启 |
| **S5** · 限流（关键端点） | 2026-05-09 | 内存固定窗口；P2 Redis 落地后切换。每日配额留给 P16 |
| **P6** · PG 连接池（部分）| 2026-05-09 | max 10→15；pgbouncer 等 2c4g+ 再做 |
| **P7** · 数据库备份（本机层）| 2026-05-09 | cron `pg_dump` + 7 天 retention；OSS 异地备份等 P3/P12 |
| **P10** · 删除客户端 OpenAI fallback | 2026-05-09 | 客户端不再持有任何上游 API key |
| **Q2** · `/api/*` 抽到 `routes/proxy.ts` | 2026-05-09 | 随 S2 一起做 |

---

## 目标架构总览

参考成熟 AI 产品（ChatGPT / Perplexity / Speak / Replika 等）的通行结构，PhotoSpeak 的长期目标分层：

```
[Mobile RN]   [Web Next.js（未来）]
        ↓
[CDN + LB]                    Cloudflare / 阿里云 SLB · HTTPS · DDoS
        ↓
[API Gateway]                 JWT / 限流 / CORS / 路由 / 版本管理
        ↓
[Services]
  ├─ AI Service              Prompt + Streaming + Context
  ├─ User & Auth             账号 / Session / OAuth
  └─ Background Jobs         邮件 / 推送 / 定时清理 / 备份
        ↓
[LLM Gateway]                 多 provider 路由 + 降级 + Token 计费
   → MiMo / DashScope / Claude / GPT / Gemini ...
        ↓
[Data]
  ├─ PostgreSQL              业务数据（用户 / session / card）
  ├─ Redis                   缓存 / 队列 / 限流 / 配额计数
  ├─ OSS                     音频 / 图片 / TTS 缓存
  └─ Vector DB（按需）        pgvector / Qdrant — 语义搜索 / 个性化
        ↓
[Observability]               Logs · Traces · Metrics · Cost
```

**当前差距对照**（按补全成本排序）：

| 层 | 现状 | 短期（Phase 1–3） | 长期（Phase 4–6） |
|----|------|------------------|------------------|
| 边缘 | 直连 ECS IP，HTTP | 阿里云 SLB + HTTPS | Cloudflare（海外用户接入时）|
| 网关 | Hono middleware | 仍在 Hono，但中间件分层 | 独立 API Gateway（多服务后）|
| AI 调用 | `fetch` 散在路由里 | **LLM Gateway 抽象层（P14）** | 多 provider 路由 + 降级 |
| 异步 | 同步 `await fetch` | BullMQ + Redis（P2）| Background Jobs 独立服务（P17）|
| 数据 | 只有 PG | + Redis | + Vector DB（如做语义搜索/个性化）|
| 客户端 | RN only | RN | + Next.js Web（Q6）|
| 可观测 | 无 | Sentry + 结构化日志（P1, P8）| Grafana 全套 + 成本面板（P19）|

---

## 🔴 高危问题（现在就可能被攻击或导致数据泄露）

### S1 · 关掉 legacy `APP_SHARED_TOKEN` 通道（分 3 步）
- [x] **Phase 1 — 加观测**（2026-05-09 完成）
  - middleware 在 JWT 和 legacy 两条分支都打结构化日志，字段含 `mode: 'jwt' | 'legacy'`、`userId`、`clientVersion`、`clientPlatform`、`ip`、`userAgent`
  - 客户端 `backendRequest()` 每次请求带 `X-Client-Version` + `X-Client-Platform` header
  - `.env.example` 标 `EXPO_PUBLIC_API_TOKEN` 为 deprecated；`backend/README.md` 同步更新
  - 文件：[backend/src/auth/middleware.ts](../backend/src/auth/middleware.ts)、[src/api/backend.ts:101-110](../src/api/backend.ts#L101-L110)
- [ ] **Phase 2 — 观测期**（建议 2–4 周，等待 P1 监控接好后并行做）
  - 每周用 `pm2 logs photospeak-api | grep '"event":"auth"' | jq` 切片：`mode='legacy'` 的请求数、独立 IP 数、对应的 `clientVersion`（多半是空字符串=老 build）
  - 确认下面这两条都达标后才推进 Phase 3：
    - legacy 请求占比 < 1%（连续 7 天）
    - legacy 调用集中在已知可强制升级的版本上，或被识别为非真实用户流量
- [ ] **Phase 3 — 删除 legacy 分支**
  - `backend/src/index.ts:78` 改为 `app.use('/api/*', requireAuth())`（不传 `APP_SHARED_TOKEN`）
  - middleware 中的 legacy 分支整段删除
  - 客户端发版强制升级提示（依赖 P23 API 版本化提供的 client-version 检测）
  - 移除 `APP_SHARED_TOKEN` env 和 `.env.example` 里的占位
- **问题**：`requireAuth(env.APP_SHARED_TOKEN)` 让 legacy token 等同 JWT。该 token 历史上通过 `EXPO_PUBLIC_API_TOKEN` 被打进过客户端 bundle，任何拿到旧版 IPA/APK 的人都能解包提取，绕过用户身份直刷代理端点。
- **背景**：当前客户端 `backendRequest()` 已经只发 JWT，**不再 fallback** 到 legacy token，所以新装机的用户是干净的。仍在用 legacy 的全部是历史 build——Phase 2 就是去量化"还有多少历史 build 在跑"。

### S2 · `/api/*` 代理加输入校验 + body 大小限制 ✅（2026-05-09）
- [x] `/api/transcribe`、`/api/analyze`、`/api/tts` 都加 zod schema 校验
- [x] 加 body size limit（transcribe 15MB，analyze 5MB，tts 64KB）
- [x] 路由抽到 [backend/src/routes/proxy.ts](../backend/src/routes/proxy.ts)（顺手把 Q2 做了）
- **文件**：[backend/src/routes/proxy.ts](../backend/src/routes/proxy.ts)、[backend/src/index.ts:73-82](../backend/src/index.ts#L73-L82)
- **关键收紧点**：
  - `model` 字段用 `z.literal()` 锁定为我们客户端实际发的值（`qwen3-asr-flash` / `mimo-v2.5` / `mimo-v2.5-tts`），堵掉"用我们的代理刷其他 MiMo / OpenAI 模型"的滥用面
  - 未识别字段被 zod 默认行为静默丢弃（`stream`、`tools` 之类塞进来不会被转发到上游）
  - 字符串 / 数组 / 数字都加了上界，配合 bodyLimit 形成两道闸
- **遗留**：未来 P14 LLM Gateway 起来后，schema + 路由应迁过去，`fetch` 直接调用消失。

### S3 · CORS 收紧 ✅（2026-05-09）
- [x] 直接移除了 wildcard `cors()`——mobile 客户端不走 CORS，`/privacy`+`/terms` 是浏览器直接导航也用不上 CORS
- **文件**：[backend/src/index.ts:44-51](../backend/src/index.ts#L44-L51)
- **遗留**：将来上 Web 客户端（Q6）时，在原位置加 `cors({ origin: [...] })`，origin 限定到已备案前端域名——comment 已留好提示。

### S4 · 全局错误处理 ✅（2026-05-09）
- [x] `app.onError()` 处理路由异常：HTTPException 透传原 4xx，其他统一返回 generic 500 + 落结构化错误日志
- [x] `process.on('uncaughtException')` 和 `process.on('unhandledRejection')` 都加了，记完日志后 `process.exit(1)` 让 PM2 重启
- **文件**：[backend/src/index.ts:84-130](../backend/src/index.ts#L84-L130)
- **设计选择**：进程级 handler 不 swallow——状态可能已脏，宁可让 PM2 拉起新进程，也不让一个坏请求拖垮后续所有请求。客户端永远看不到内部 stack（只看到 `{"error":"internal server error"}`），日志在服务端落 `event:"error"` / `event:"fatal"` 两种 JSON 行。

### S5 · 限流（关键端点全覆盖）✅（2026-05-09 部分完成）
- [x] `/auth/send-code`：IP 20/h（middleware）+ 手机号 5/天（handler 内）
- [x] `/auth/verify`：IP 30/15min + 手机号 10/15min
- [x] `/api/*`：用户 30/min（legacy 客户端 fallback 到 IP 30/min）
- [ ] 全局按 IP 兜底——未做。NAT 后大量真实用户共享 IP 时容易误伤，等有了真实流量数据再决定要不要上。
- [ ] 每日配额（按 user 累计每天）——这是 P16 的工作，需要 Redis 落地后做
- **文件**：[backend/src/middleware/rate-limit.ts](../backend/src/middleware/rate-limit.ts)、[backend/src/routes/auth.ts](../backend/src/routes/auth.ts)、[backend/src/routes/proxy.ts](../backend/src/routes/proxy.ts)
- **实现说明**：内存固定窗口限流，单进程足够。多进程（P9 PM2 cluster）或多机（P11 SLB）部署后必须迁 Redis（P2）——`rate-limit.ts` 公共接口设计成只把 `stores` Map 换成 Redis 客户端就能切。
- **遗留**：上面两个 `[ ]` 进了 P16 范围。

### S6 · ICP 备案完成后立刻切回 HTTPS
- [ ] 后端切回 `https://api.dailyphotospeak.cn`
- [ ] 移除 `app.json` 的 ATS 异常
- [ ] 强制旧版客户端升级（旧版 `EXPO_PUBLIC_API_BASE` 还指向 IP）
- **文件**：[app.json:18-26](../app.json#L18-L26)
- **问题**：当前所有流量明文走 `http://47.102.40.169`——token、录音、照片、转写文本全部可被中间人截获。这是已知的临时方案，但备案一通过就必须立即收回。
- **修复方向**：备案下来当天发新版本（`EXPO_PUBLIC_API_BASE` 改 https 域名 + 移除 ATS 例外）；后端域名指过去后保留 IP 一段时间作为兜底，等强制升级生效再下线。

---

## 🟡 性能/稳定性隐患（用户多了会出问题）

### P1 · 接入监控（Sentry + APM + 业务指标）
- [ ] 重新接 Sentry（DSN + config plugin 一起回来，恢复 source map 上传）
- [ ] 接 APM（阿里云 ARMS 或自建 OpenTelemetry → Grafana）
- [ ] 业务面板：队列长度、worker 占用、上游配额使用率、当日请求成本
- **文件**：[app/_layout.tsx:14-22](../app/_layout.tsx#L14-L22)（JS Sentry init 已存在但 plugin 被移除）；提交 [`afe1c60`](../) 移除了 Sentry plugin
- **问题**：当前线上崩了完全不知道；后续优化都是瞎猜。
- **修复方向**：先把 Sentry 接回来（最低成本拿到崩溃流），再选 APM 看 P95/P99 与上游耗时分布。指标先于优化。

### P2 · 异步化改造（同步直通 → 队列 + worker）⭐
- [ ] 引入 Redis（建议 Aliyun 云数据库 Redis 版）
- [ ] 用 BullMQ 建立任务队列（transcribe / analyze / tts 三类 job）
- [ ] 后端 API 收到请求即返回 `session_id` + `status: queued`
- [ ] worker 池消费队列并写结果回 DB
- [ ] 客户端轮询或 SSE 监听完成事件
- **文件**：当前 [backend/src/index.ts:80-120](../backend/src/index.ts#L80-L120) 是同步 `await fetch(upstream)`
- **问题**：上游 LLM 5–30s 期间每个请求占 TCP 连接 + Node socket + audio buffer。1000 并发 = 单机直接 OOM；上游配额也会同时被打爆。
- **修复方向**：API 进程只负责入队和查询，不再持有上游连接。worker 数量显式控制上游并发上限（比如 30 worker = 永远 ≤30 个 MiMo 并发），自然规避上游限流。这一项是后面所有扩容动作的前提。

### P3 · 音频走 OSS presigned URL（仅剩 TTS / 用户录音存档场景）
- [x] **transcribe 路径**（2026-05-12 完成）：客户端直连 DashScope `paraformer-realtime-v2` WebSocket，backend 只签短期 token（`POST /api/transcribe/token`），全程不接触音频字节。这是 P3 的最大头，已 ship。
- [ ] **TTS 输出**：MiMo TTS 生成的 base64 仍走 backend → 客户端写本地。改造方向：backend 直接把生成结果落 OSS，返回签名 URL；和 P4（TTS 缓存）+ P24（客户端云优先存储）合并做。
- [ ] **用户录音文件**：当前 WAV 落本地磁盘，未来要不要存档到云端是 Q4（数据上云策略决策）的子集。
- **文件**：[backend/src/routes/transcribe.ts](../backend/src/routes/transcribe.ts)（新加的 token 签发）、[src/api/aliyun-asr.ts](../src/api/aliyun-asr.ts)（WS 客户端）、[src/hooks/useAudioRecorder.ts](../src/hooks/useAudioRecorder.ts)（PCM tee）
- **历史问题**：音频 base64 整块进后端内存。1000 并发 × 5MB ≈ 5GB 内存峰值。
- **现状**：transcribe 体感延迟从 4–10s 降到 < 1s，backend 内存峰值不再随 transcribe 并发数膨胀（一次 token 签发是 ~200 字节 JSON）。剩下两个子项体量小，跟着 P4/P24 一起做即可。

### P4 · TTS 结果缓存
- [ ] 计算 `key = sha256(text + voice_id + model)`
- [ ] 命中 OSS 直接返回 URL；未命中调 MiMo TTS、写 OSS、入缓存索引（PG 表或 Redis）
- **文件**：[src/api/mimo-tts.ts](../src/api/mimo-tts.ts)、[backend/src/index.ts:109-120](../backend/src/index.ts#L109-L120)
- **问题**：同样的 chunk 例句被 100 个用户学就 TTS 100 次，纯浪费。
- **修复方向**：跑一段时间后命中率会很高，TTS 配额压力降一个数量级。Whisper / 分析无法这样缓存（输入因人而异），但 TTS 必须缓存。

### P5 · 上游 fetch 加超时
- [ ] 所有 `fetch(upstream)` 加 `AbortSignal.timeout(30_000)`（按业务定阈值）
- **文件**：[backend/src/index.ts:82-93, 96-107, 109-120](../backend/src/index.ts#L82-L93)
- **问题**：上游 hang 住时连接一直挂着，慢慢吃光资源。
- **修复方向**：超时后返回 504，让客户端可以重试或降级。

### P6 · PG 连接池 + pgbouncer 🟡（部分完成 2026-05-09）
- [x] `max` 从 10 升到 15（保守一档；2c4g+ 后再升 20-30）
- [ ] pgbouncer——LAS 1c1g 还跑不动多一个进程，等升 2c4g + 多进程（P9 cluster / P2 worker）后再上
- [ ] 监控连接等待队列——等 P1 监控落地后挂上
- **文件**：[backend/src/db/client.ts:11-21](../backend/src/db/client.ts#L11-L21)
- **问题**：当前 max=10，多 worker / 多进程上来后立刻打满。
- **修复方向**：pgbouncer 后大量短连接复用少量真实 PG 连接，应用侧不用关心精确数量。

### P7 · 数据库备份机制 ✅（2026-05-09，本机层）
- [x] `backend/scripts/backup.sh`：每天 cron 跑 `pg_dump` → `/var/backups/photospeak/`，gzip 压缩，7 天 retention
- [x] `backend/README.md` 加部署 + cron 配置 + 恢复指令
- [ ] OSS 异地备份——等 P3 / P12 OSS 通路就绪后在脚本末尾加 `ossutil cp`，目前只防误删表 / migration 失误，不防 LAS 整盘损坏
- [ ] 长期迁 Aliyun RDS（自动快照 + 时间点恢复）——P11 一并做
- **文件**：[backend/scripts/backup.sh](../backend/scripts/backup.sh)、[backend/README.md](../backend/README.md)
- **当前防什么**：误 DROP TABLE、migration 跑坏、人为误改数据 → 7 天内可恢复
- **当前不防**：LAS 物理损坏 / 整盘抹除 → 备份和数据库在同一块磁盘上，OSS 异地备份接上后才完整

### P8 · 日志结构化 + 轮转
- [ ] `console.log` 替换为 pino（或类似）
- [ ] 关键事件：用户 ID、请求 ID、上游耗时、错误码
- [ ] 加 logrotate 配置或 pino 内置 rotation
- **文件**：当前后端只用 `console.log`
- **问题**：PM2 logs 在 `~/.pm2/logs/` 无轮转策略，磁盘可能慢慢被吃掉；非结构化日志后期无法做查询和告警。
- **修复方向**：pino + pino-pretty（开发）+ JSON 输出（生产），接 P1 的 APM。

### P9 · PM2 cluster mode
- [ ] `ecosystem.config.cjs` 加 `instances: 'max'`、`exec_mode: 'cluster'`
- **文件**：[backend/ecosystem.config.cjs:10-24](../backend/ecosystem.config.cjs#L10-L24)
- **问题**：当前单进程，CPU 多核浪费。
- **修复方向**：cluster mode 立刻拿到 N 倍 CPU 吞吐，但要求后端无状态（P2 完成后自然满足）。注意限流 / 缓存若用进程内存会失效，必须迁到 Redis（P2 引入）。

### P10 · 删除客户端 OpenAI fallback ✅（2026-05-09）
- [x] [src/api/whisper.ts](../src/api/whisper.ts)：移除 `EXPO_PUBLIC_OPENAI_API_KEY` 分支；endpoint 未配置时直接抛错（不再 fallback 到 OpenAI 公网）
- [x] [src/api/stt.ts](../src/api/stt.ts)：默认 provider 从 `whisper` 翻成 `aliyun-qwen`，只有显式设 `EXPO_PUBLIC_STT_PROVIDER=whisper` 才走本地 dev path
- [x] [.env.example](../.env.example)：删除 `EXPO_PUBLIC_OPENAI_API_KEY` + `EXPO_PUBLIC_DASHSCOPE_API_KEY` 字段，加 deprecation 说明
- **文件**：[src/api/whisper.ts](../src/api/whisper.ts)、[src/api/stt.ts](../src/api/stt.ts)、[.env.example](../.env.example)
- **保留**：`whisper.ts` 还在仓库里，但只服务于本地 dev（用户在 Mac 跑 `scripts/local_whisper_server.py`）。production 走 backend 代理永远到不了这条路径。

### P11 · 横向扩展准备 + 迁移 Aliyun RDS
- [ ] 自管 PG → Aliyun RDS PostgreSQL（主从 + 自动备份）
- [ ] 后端前面加阿里云 SLB
- [ ] 至少 2 台 ECS（API 进程） + 独立的 worker 机器组
- **依赖**：P2、P9 完成
- **问题**：单机 ECS 是硬天花板。
- **修复方向**：API 进程和 worker 分开扩缩容；RDS 做主备，读副本可承担 stats / 列表查询。

### P12 · 静态资源 / 音频走 OSS + CDN 出口
- [ ] 生成的 podcast 音频和 TTS 缓存全部存 OSS
- [ ] 客户端拿签名 URL 直接从 OSS / CDN 拉
- **文件**：当前音频 URL 由后端代理或本地路径
- **问题**：后端流音频会占带宽和 CPU。
- **修复方向**：后端只签 URL，不参与音频字节传输。配合 P3、P4 自然成形。

### P24 · 客户端音频存储治理（云优先 + LRU 缓存）
- [ ] TTS 音频后端生成时直接上 OSS（**依赖 P4**——TTS 缓存的 OSS 是同一份存储）
- [ ] 客户端拿 OSS 签名 URL 流式播放，本地不再永久持有（**依赖 P12** OSS + CDN 出口）
- [ ] 本地改成 LRU 缓存，上限 200-500MB；满了淘汰最久没播的 session 的 TTS 文件
- [ ] 保留：用户录音、原图、缩略图（体积小且有"我之前说过什么"的纪念价值）
- [ ] 设置页 / Home 页：显示当前缓存大小 + 手动清理按钮 + ⭐"保留此 session" 标记
- [ ] 离线行为：命中缓存可播，未缓存的 session 在 listening 列表灰显并提示"上线后可播"
- [ ] 一次性迁移：现有用户本地的 WAV 文件上传到 OSS、回填 `sentence_audio_uris` 为云端 URL（迁移脚本，对老用户透明）
- **问题**：当前所有 TTS 音频（WAV 未压缩 + 每句一文件）+ 用户录音 + 照片**全部永久保存在手机本地**。每个 session 平均 7-22MB，每天 1 session 用半年就占手机 1-2GB。3-6 个月后真用户会开始抱怨。
- **不做的折中**：
  - 仅改 MP3（省 6×）→ 只是把"3 个月开始痛"推到"1 年开始痛"，治标
  - 仅加本地清理 UI → 用户清完丢失记录，体验差
  - 这件事**要做就做对**：音频 source of truth 在云端，本地是有上限的缓存。这是行业标配（每日英语听力、Apple Podcasts、Spotify、网易云）的做法。
- **依赖图**：P3（OSS 上传基础设施）+ P4（TTS 缓存到 OSS）+ P12（OSS + CDN 出口）→ 三件都到位后这件事才能优雅落地。所以 P24 进 Phase 4 末段，等前置就绪后一起做。

### P13 · 上游并发配额谈判
- [ ] 联系 MiMo / DashScope 提升并发 quota
- [ ] 评估是否需要多 key 分片（不同 user 落到不同 key）
- **问题**：上游配额是真正的硬天花板，技术再好也突破不了。
- **修复方向**：先量化当前配额（接 P1 后能看到），再和供应商谈下一档。多 key 分片是兜底方案，但运营复杂度上升，能不上就不上。

### P14 · LLM Gateway 抽象层 ⭐（建议在 Phase 3 和 P2 一起做）
- [ ] 把所有上游调用收敛到一个内部模块（`backend/src/llm/`），routes 不再直接 `fetch(MIMO_BASE/...)`
- [ ] 接口形状：`llm.transcribe(input)` / `llm.analyze(input)` / `llm.tts(input)`，内部决定打哪个 provider
- [ ] 每次调用带 `(user_id, request_id, model, input_tokens, output_tokens, upstream_cost, latency_ms)` 落库
- [ ] 内置重试（仅幂等）、熔断（错误率阈值）、超时（接 P5）
- **依赖**：P2 异步化时这一层最自然成形
- **问题**：当前 `fetch` 散在路由里，换 provider / 加 fallback / 统计成本无处挂。这是后面 P15、P19、P20 的承载。
- **修复方向**：参考开源实现 [LiteLLM](https://github.com/BerriAI/litellm) / [Portkey](https://portkey.ai/) / [Helicone](https://helicone.ai/) 的接口形状，但内部精简到只支持当前需要的 provider。先抽象出来，多 provider 路由（P15）可以稍后填充。

### P15 · 多 provider 路由 + 降级
- [ ] 主备 provider 表：MiMo 失败自动切到（例如）Qwen / 智谱
- [ ] 按业务分级路由：分析用强模型、TTS 用专用模型、未来轻量分类用便宜模型
- [ ] 熔断：某 provider 错误率 5 分钟超 20% → 自动切备用
- **依赖**：P14 完成
- **问题**：当前单 provider 单点故障；MiMo 一抖 PhotoSpeak 全挂。
- **修复方向**：在 LLM Gateway 内部维护 provider 健康状态，路由表用配置（接 P21 prompt/模型外置后可热更）。

### P16 · Per-user 每日配额（成本上限）
- [ ] 表 `user_quota_daily(user_id, date, transcribe_count, analyze_count, tts_chars, cost_cents)`
- [ ] LLM Gateway 调用前查 quota，超额返回 429 + `X-Quota-Reset` header
- [ ] 免费/付费分层：免费 5 sessions/天，付费按等级
- **依赖**：P14（在 Gateway 一处拦截）+ Redis（计数器）
- **问题**：S5 限流防短时爆刷，但**不防长期蚕食**。一个用户每分钟 10 次合规 × 24 小时 = 一天 14400 次调用，照样能把上游配额吃光。AI 产品的成本控制必须按用量配额，不是只按速率。
- **修复方向**：Redis 做日级计数器（`quota:{user_id}:{date}`，TTL 48h），Gateway 调用前 incr，超额拒绝。免费/付费分层到时候改一个数即可。

### P17 · Background Jobs 服务化
- [ ] 拆分 worker：AI 任务一组（transcribe/analyze/tts），通用任务一组（推送通知 / 邮件 / 7天软删除清理 / pg_dump）
- [ ] 定时任务接 BullMQ 的 repeatable jobs
- **依赖**：P2 异步化
- **问题**：现在没有定时任务承载层，未来推送提醒、定期清理、发送 weekly summary 邮件都没地方落。
- **修复方向**：和 AI worker 共用 Redis + BullMQ，但 queue 名分开，便于独立扩缩容。

### P18 · 流式输出（SSE）
- [ ] AI Service 关键回复路径改 SSE（chat 跟进、analyze 流式输出）
- [ ] 客户端用 `react-native-sse` 接流
- [ ] TTS 走 ElevenLabs / MiMo 流式接口（产生即播）
- **依赖**：P14 LLM Gateway 接口设计需要预留 stream 模式
- **问题**：当前是 buffer-and-return，3 秒响应 = 3 秒空白屏；流式同样 3 秒首字节但用户体感秒回。这是现代 AI 产品的 UX 默认值。
- **修复方向**：分两步：先 SSE 文本流（chat 接口），再 audio 流式合成（更复杂，可延后）。

### P19 · 成本作为一等指标
- [ ] LLM Gateway 每次调用落库 `(user_id, request_id, model, input_tokens, output_tokens, cost_cents)`
- [ ] Grafana 面板：按用户 / 模型 / 路由 / 时间切片看花销
- [ ] 告警：单用户单日 > X 元、总日花销 > Y 元
- **依赖**：P14 + P1（监控基建）
- **问题**：上游账单只能看总额，看不出谁在花。1000 并发上来后，找出滥用账号、决策付费分层、优化 prompt 成本都需要这层数据。
- **修复方向**：参考 [Helicone](https://helicone.ai/) / [Langfuse](https://langfuse.com/) 的数据模型，自建一张 `llm_calls` 表 + Grafana 面板。

### P20 · 内容安全 / Moderation
- [ ] 上传照片调用阿里云内容安全（图片审核）
- [ ] 录音/转写文本审核
- [ ] 违规留底（用户举报后能取证）
- **问题**：用户上传照片 + 音频的产品，App Store 和工信部都有合规要求。出一次事故就是下架风险。
- **修复方向**：阿里云内容安全 API 直接接，违规阻断 + 入审计表。可在 worker 入队后第一步执行。

### P21 · Prompt + 模型配置外置 + Feature Flag
- [ ] system prompt 从代码挪到 DB（表 `prompts(name, version, content, active)`）或配置中心
- [ ] 引入 feature flag（GrowthBook 自托管或简易 DB 表 + 缓存）
- [ ] 灰度发布：新 prompt / 新模型先开 1% → 10% → 100%
- **问题**：改 prompt 现在要发版；想 A/B 测两版 prompt 没有承载；新模型上线只能全量切。
- **修复方向**：先做最小版本——一张 prompts 表 + cache（Redis 5 分钟 TTL）+ admin UI（可在 P22 admin 后台里加）。Feature flag 可以晚一些上。

### P22 · Admin 后台
- [ ] 用户列表 / 单用户 session 详情查看
- [ ] 失败请求查看 + 重放
- [ ] 配额调整 / 退款 / 封禁
- [ ] Prompt / Feature flag 管理（接 P21）
- **问题**：用户量过千就必须有，否则 support 成本爆炸——现在出问题只能 SSH 进库 SELECT。
- **修复方向**：内部用，简陋一点没关系。Next.js + 复用后端 API + 简易管理员表 / IP 白名单即可。

### P23 · API 版本化
- [ ] URL 前缀加版本：`/v1/api/transcribe`、`/v1/auth/...`
- [ ] 旧路径维持一段过渡期，逐步重定向
- [ ] 客户端在 header 带 `X-Client-Version`，便于服务端按版本兼容
- **问题**：未来要改接口形状（比如 P3 改音频上传方式、P18 加流式），如果没版本号就是破坏性升级，老客户端全挂。
- **修复方向**：现在加 v1 前缀，几乎零成本；将来 v2 时新老并存，按客户端版本路由。

---

## 🟢 代码质量建议（有空再处理）

### Q1 · 手写校验换成 zod schema
- [ ] auth 路由的 typeof / 正则校验全部迁移
- **文件**：[backend/src/routes/auth.ts:36-125](../backend/src/routes/auth.ts#L36-L125)
- **理由**：当前规则简单还能扛，路由一多就会漂移；S2 已经引入 zod 后，统一掉成本很低。

### Q2 · `/api/*` 代理路由抽到 `routes/proxy.ts` ✅（2026-05-09）
- [x] 从 `index.ts` 拆出，随 S2 一起做
- **文件**：[backend/src/routes/proxy.ts](../backend/src/routes/proxy.ts)

### Q3 · 多环境分离
- [ ] `.env.development` / `.env.staging` / `.env.production` 分别管理
- [ ] 客户端 base URL 按 build profile 切换
- **文件**：当前 [src/api/backend.ts:15](../src/api/backend.ts#L15) 单一 BASE
- **理由**：现在测试改一次 `.env` 影响所有环境，发布前容易出错。

### Q4 · 数据上云策略决策
- [ ] 决策：sessions / cards 是否服务端持久化？
- [ ] 如果上云：设计 schema、同步协议、冲突解决
- **背景**：当前 [backend/drizzle/0000_wise_magik.sql](../backend/drizzle/0000_wise_magik.sql) 只有 `users` + `refresh_tokens`，会话数据全在客户端 SQLite。
- **理由**：换手机 / 重装即丢——用户量起来后投诉是必然。本地优先 vs 上云同步两条路越早定方向越好，影响后面索引设计、备份范围、迁移成本。

### Q5 · 请求 ID + trace 贯穿
- [ ] 入口生成 request_id，写入日志、Sentry tag、上游调用 header
- **理由**：定位问题时能从一个 ID 串起前后端 + 上游。配合 P1、P8 一起做最划算。

### Q6 · Web 客户端（Next.js）
- [ ] 复用同一套后端 API
- [ ] SSR 落地页 + Web 版练习界面
- **背景**：参考架构里 mobile + web 共用 backend 是标配。Web 端能让用户从 Twitter / 推广文章直接试用，不用先下载 app——增长漏斗顶层的入口。
- **理由**：长期增长动作，但等你 mobile 稳了再做。后端 API 设计时（特别是 P23 版本化）就考虑到 Web 客户端的需求，避免后期重做。

### Q7 · Vector DB 决策（pgvector / Qdrant）
- [ ] 决策：是否需要语义搜索 / 个性化推荐？
- [ ] 备选：pgvector（PG 内置，运维简单）vs Qdrant（专用，性能好）
- **背景**：参考架构提到了 Vector DB，但 PhotoSpeak 当前功能（FSRS、TTS、分析）**都不需要 embedding**。仅当未来做以下任一时才需要：
  - "你以前说过 X" — 跨 session 语义检索
  - 智能 chunk 推荐 — 基于用户历史选高价值短语
  - 跨用户内容推荐 — 别的学习者类似 session 推过来
- **理由**：先想清楚业务需要它解决什么问题，再选实现。能用 pgvector 解决就别上 Qdrant。

### Q8 · API Gateway 独立层
- [ ] 当后端拆分为 ≥3 个微服务时，把 Hono middleware 中的认证 / 限流 / CORS 上移到 Kong / 阿里云 API 网关
- **背景**：参考架构图里 API Gateway 是独立层，但那是为了多服务共享。PhotoSpeak 当前单体后端，Hono middleware 就是网关，没必要单独拆出来。
- **理由**：等到 AI Service / Auth / Background Jobs 真的拆成独立进程并部署到不同机器时再做，否则徒增运维成本。

---

## 落地顺序建议

按"对扛住增长 + 堵住已知风险"的边际收益排：

### Phase 1：本周堵口（🔴 全部）
S1 → S2 → S3 → S4 → S5 → S6（S6 等备案，其余立即）
完成后：钱包不会被刷穿，进程不会无声崩溃，明文流量收回。

### Phase 2：上观测（无指标谈优化都是瞎猜）
P1（Sentry 先回来 → APM → 业务指标）+ P8（结构化日志）+ Q5（request_id）
完成后：能量化下面每一步的实际收益。

### Phase 3：异步化 + LLM Gateway（扩容的地基 + 后续运营的承载）⭐
P2（队列 + worker）→ **P14（LLM Gateway 抽象）** → P3（音频走 OSS）→ P4（TTS 缓存）→ P5（上游超时）
完成后：单机能稳扛 200–300 并发；上游配额压力下降一个数量级；后续成本统计 / 多 provider / 配额都有挂载点。
**关键提示**：P14 必须和 P2 同期做。P2 在改 routes 时顺手抽 LLM Gateway 出来，比之后单独回来重构便宜一个数量级。

### Phase 4：横向扩展
P9（PM2 cluster）→ P6（连接池 + pgbouncer）→ P11（RDS + SLB + 多 ECS）→ P12（OSS + CDN 出口）→ **P24（客户端云优先音频存储 + LRU 缓存）**→ P7（备份）→ P13（上游配额谈判）
完成后：1000 并发不是问题，用户手机也不会被音频塞爆。

### Phase 5：运营成熟度（用户量起来后陆续做）
按"出问题概率 × 后果严重性"排序：
P16（per-user 配额）→ P19（成本面板）→ P20（内容安全）→ P15（多 provider 降级）→ P18（流式输出）→ P22（admin 后台）→ P21（prompt 外置 + flag）→ P23（API 版本化）→ P17（Background Jobs 服务化）

各项做完的标志：
- P16 + P19：能回答"哪个用户最贵 / 今天总花了多少 / 谁在滥用"
- P20：能在 App Store / 政策审核中通过内容合规问题
- P15：MiMo 抖动 30 秒不影响用户
- P18：用户感知首字节延迟从 3s 降到 < 500ms
- P22：客服不用 SSH 改库就能处理用户问题

### Phase 6：清理 + 长期决策
P10（OpenAI fallback 删除）→ Q1 → Q2 → Q3 → Q4 → Q5 → Q6（Web 客户端）→ Q7（Vector DB 决策）→ Q8（API Gateway 独立层）

---

## 备注
- 每个 Phase 跑完都用 P1 的指标验证收益（P95 延迟、错误率、上游配额使用率、单用户日均成本），不验证不算完。
- **Phase 3 的 P2 + P14 是关键路径**：没做完之前 Phase 4 任何扩容动作收益都有限——同步模型瓶颈在每个请求挂着的 30 秒，加机器只是把瓶颈复制 N 份。P14 LLM Gateway 不抽出来，Phase 5 几乎所有项目（成本面板、配额、降级、流式）都没地方挂。
- 上游并发配额（P13）是真正的硬天花板，做完所有技术优化但配额不够，1000 并发还是上不去。这件事可以和 Phase 3、4 并行推进，越早开始谈越好。
- 参考架构图里的 **API Gateway 独立层（Q8）和 Vector DB（Q7）** 不要急着上。前者只在多服务时才有意义，后者只在做语义搜索 / 个性化时才需要——PhotoSpeak 现阶段两个都不缺。
