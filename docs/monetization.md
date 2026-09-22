# PhotoSpeak 商业化升级方案

> **更新说明（2026-09-19）**：套餐承诺、价格实验和公平使用策略以
> [subscription-policy.md](subscription-policy.md) 为准。购买验证使用 StoreKit 2、
> App Store Server API 和 Server Notifications V2；商店净收入按开发者实际费率、
> 税费与地区测算，不在代码中假定固定 30%。

> 快照时间：2026-05-12
> 用途：从内测过渡到付费版本要做的全部功能清单 + 云端存储选型 + 落地顺序。
> 命名规则：项目编号 (M1, M2...) 是稳定 ID，跨章节引用时用编号。

---

## 文档分工

| 文档 | 关注 | 例子 |
|---|---|---|
| **[optimization.md](optimization.md)** | **非功能性**：性能、安全、可观测、扩容 | 限流、Sentry、流式 ASR、PM2 cluster |
| **本文档** | **功能性**：用户能感知的新功能 + 付费体系 | 订阅、用量限制、跨端同步 |

两条线有交叉点（云端存储、配额计数），见末尾 [§ 交叉点](#与-optimizationmd-的交叉点)。

---

## 商业模式（已定）

### 定价

| 套餐 | 价格 | 说明 |
|------|------|------|
| 免费 | ¥0 | 每月 5 次已完成 session，1 次 follow-up/session，本地存储 |
| Plus 月订阅 | ¥38/月 | 正常个人学习不限 session 和 follow-up；本地历史/音频 |
| Plus 年订阅 | ¥328/年 | 同上，折合约 ¥27.3/月 |

¥28/月或首年 ¥228 只作为限时 introductory offer / offer code 测试，
不作为永久续订价。当前版本没有云端学习内容同步，因此不能在付费页承诺云端音频。

### 收支平衡点

| 成本项 | 月均 |
|--------|------|
| 服务器 + 域名 | ¥42 |
| Apple Developer | ¥57 |
| API（随用户增长） | 浮动 |
| **固定合计** | **¥99** |

固定成本的盈亏平衡人数必须用 App Store Connect 的实际净收入以及 usage ledger
里的 P50/P95 付费用户可变成本计算；不能只用标价除固定成本。

### 免费层设计逻辑

- 5 次够体验完整闭环（录音 → 转写 → 分析 → TTS → cards）
- 不够养成每日习惯（习惯需要 21+ 天连续触发）
- 自然产生升级动力

### 内测用户转化策略

上线时可给现有内测用户发 offer code：首月 ¥28 或首年 ¥228。优惠应有明确
适用人群与结束时间，确认页必须显示优惠结束后的正常续订价。

---

## 待建功能清单（按依赖关系排序）

### M1 · 苹果内购 + 订阅状态 ⭐ 必做基础
- [ ] 客户端：集成 StoreKit 2（可用支持 StoreKit 2 的 React Native IAP 适配层或自有 Expo module），购买后把签名交易发给后端
- [ ] App Store Connect：创建月订阅 + 年订阅两个 product；配置 Subscription Group + Subscription Levels
- [ ] 后端：接收 StoreKit 2 signed transaction，以 App Store Server API 复核 transaction/originalTransactionId 后写入独立 entitlement 与 transaction 表
- [x] DB 已有独立 `user_entitlements` 基础表；仍需 transaction、notification 去重日志及账号转移策略
- [ ] App Store Server Notifications V2（续费、取消、退款、billing retry、grace period）→ 验证 JWS 后幂等入库
- [ ] 客户端轮询订阅状态（启动时 + 进 paywall 前），从后端拿权威值，不信任本地缓存
- **难点**：Sandbox/Production 环境、恢复购买、退款、家庭共享、宽限期、重复通知与账号迁移都必须端到端覆盖；客户端本地标记不能成为权威权益。
- **参考**：Apple [In-App Purchase](https://developer.apple.com/in-app-purchase/) 与 [App Store Server Notifications](https://developer.apple.com/documentation/appstoreservernotifications)

### M2 · 免费层用量限制
- [ ] DB 表 `user_usage_monthly(user_id, year_month, session_count, followup_count_by_session)`
- [ ] 后端 `/api/analyze` 调用前 check：如果 user 是 free + 当月 session ≥ 5 → 返回 402 + 错误码 `quota_exceeded`
- [ ] follow-up 一样 check：免费用户当前 session 已有 1 次 follow-up → 拦截；Plus 不展示或执行月度次数配额
- [ ] 客户端拦到 402 → 弹 paywall（M6）
- [ ] 客户端首屏 / Home 显示"本月已用 X/5 次"
- [ ] 月底自动重置 — cron job `0 0 1 * *` 直接清表（或用 `year_month` 字段天然分区，不用清）
- **依赖**：M1（要知道用户付费状态才能区分免费/付费）
- **跟 optimization 的交叉**：[P16](optimization.md#p16--per-user-每日配额成本上限) 是按 cost 控成本，M2 是按 session 数控产品体验。两者数据模型相似（Redis 计数器），可共享基础设施

### M3 · 云端音频存储
- [ ] Aliyun OSS bucket：`photospeak-prod-audio`（生产）+ `photospeak-staging-audio`（测试）
- [ ] 后端 `POST /api/uploads/presign` 签 OSS PUT URL（按 user_id 分目录 prefix）
- [ ] TTS 生成时：worker 直接上 OSS，不再返 base64 给客户端
- [ ] 客户端拿 OSS 签名 URL（GET 也是短期签名）流式播放
- [ ] 本地 LRU 缓存（200-500MB），淘汰最久没播的 session
- [ ] 一次性迁移脚本：逐个发现旧版地录音格式（m4a/caf/wav 等）、校验后上传到 OSS，并把 `sentence_audio_uris` 回填为 OSS key；不要把内测用户数或文件格式写死
- **依赖**：optimization.md 的 [P3](optimization.md#p3--音频走-oss-presigned-url仅剩-tts--用户录音存档场景) + [P4](optimization.md#p4--tts-结果缓存) + [P12](optimization.md#p12--静态资源--音频走-oss--cdn-出口) + [P24](optimization.md#p24--客户端音频存储治理云优先--lru-缓存) 是这件事的非功能基础设施
- **难点**：迁移脚本要保证幂等（中断后能续传）、保证回填 SQLite 的事务一致性（迁移途中 app 不能写老数据）

### M4 · 跨设备同步（sessions + cards）⭐ 复杂度最高
- [ ] **服务端 schema**：把客户端 SQLite 那三张表（sessions、cards、stats）镜像到 PG
- [ ] 同步协议：客户端启动 / 后台返前台 / 切换设备时拉 server state；本地写入立刻 push（带客户端时间戳）
- [ ] 冲突解决策略：last-write-wins by `updated_at`（简单粗暴但对学习类 app 够用）
- [ ] FSRS 状态同步：`stability` / `difficulty` / `review_history` / `next_review_at` 都要同步，否则在 A 设备复习完到 B 设备又得复习一遍
- [ ] 离线模式：本地写入正常，online 后批量同步；冲突按 last-write-wins
- [ ] 一次性迁移：现有用户本地数据上云（与 M3 迁移合并执行）
- **决策点**：[optimization.md Q4](optimization.md#q4--数据上云策略决策) 标记为"开放产品决策"——本文档**正式选择上云**作为付费层的核心价值
- **难点**：FSRS 状态多机同步可能产生"已复习"幻觉。需要服务端权威 `next_review_at`，客户端只读不写（或写之后立刻 push）
- **依赖**：M1（只对付费用户开启同步）

### M5 · 内测优惠码
- [ ] App Store Connect → Promo Codes：生成 20 个一次性兑换码 + 25 个 50% off 月订阅码作为备用
- [ ] **或者**：用 Apple [Offer Codes](https://developer.apple.com/app-store/subscriptions/) 功能创建“首月 ¥28”或“首年 ¥228”的限时促销；通过 URL `https://apps.apple.com/redeem?ctx=offercodes&id=APP_ID&code=CODE` 分发，并清楚显示优惠结束后的 ¥38/月或 ¥328/年续订价
- [ ] 客户端识别从 URL 进入的 promo redemption flow（Apple 自动接管）
- [ ] DB 不需要单独管 promo code，Apple 那边自动 track
- **依赖**：M1
- **难度**：低，主要是 App Store Connect 配置 + 客户端 deep link

### M6 · Paywall UI
- [ ] 升级页：列出付费 vs 免费对比表、月/年两个购买按钮、订阅条款链接
- [ ] 触发时机：
  - 免费用户尝试创建第 6 个 session → 拦截 + 跳 paywall
  - 免费用户在同一 session 尝试第 2 次 follow-up → 同上
  - Home / Settings 顶部常驻一个"升级 PRO" 入口
  - 新用户 onboarding 第 3 步软推（不强制）
- [ ] 购买后立刻刷新订阅状态（M1）、关闭 paywall、继续用户原本操作
- [ ] 当前本地优先版本只突出“持续练习、完整分析与复习”；“跨设备不丢”必须等 M3 + M4 真正上线后才能放进付费文案
- **依赖**：M1（购买流）+ M2（拦截点）

### M7 · 用量统计后台（自用）
- [ ] 管理员后台页面：当月付费用户数、月活、新增、流失、API 成本/用户
- [ ] 数据来源：DB 直接 SQL + Sentry releases dashboard
- **依赖**：M1
- **跟 optimization 的交叉**：[P22 admin 后台](optimization.md#p22--admin-后台)是泛后台，M7 是商业指标子集，可合并

---

## 云端存储选型

### 为什么选 Aliyun OSS

- ✅ 跟现有基础设施（ECS + RDS 都在阿里云华东 2）同区域，**内网传输免费 + 毫秒级延迟**
- ✅ S3 兼容协议，SDK 成熟，迁移走人也好换
- ✅ 单价低：标准存储 ¥0.12/GB/月，国内出公网 ¥0.50/GB（CDN 加速后更便宜）
- ✅ 跟备份（[optimization.md P7](optimization.md#p7--数据库备份机制)）共用一个 OSS bucket 体系
- ❌ 海外用户访问慢（暂时不是问题，PhotoSpeak 现阶段定位国内市场）

### 数据分层

| 数据 | 存哪 | 量级 | 备注 |
|---|---|---|---|
| TTS 音频（每句一个 mp3）| OSS Standard | ~50-100KB / 句 | 配 P4 缓存后命中率会很高 |
| 用户录音（受支持的 m4a/caf/wav 等）| OSS Standard | 以真实 usage ledger 测量 | M3 上传前校验格式/大小，本地保留 LRU 缓存 |
| 照片（原图）| OSS Standard | ~500KB-2MB | 缩略图压缩到 200x200 后 ~20KB |
| 照片缩略图 | OSS Standard | ~20KB | 给 LLM 用的版本 |
| Session / Card 元数据 | **PG（不进 OSS）**| 几 KB | M4 同步用 |
| FSRS 复习状态 | **PG（不进 OSS）**| 几 K B | 频繁读写，不适合对象存储 |

### 成本估算（1000 付费用户）

假设每个付费用户日均 1 个 session：

- TTS：8 句 × 100KB = 800KB/session × 30 = 24MB/月/用户 × 1000 = **24GB/月**
- 录音：2MB/session × 30 = 60MB/月/用户 × 1000 = **60GB/月**
- 照片：1.5MB × 30 × 1000 = **45GB/月**
- **累计**：~130GB/月（持续增长）
- 存储费：130GB × ¥0.12 = ¥15.6/月
- 出公网流量（按 50% 用户每月回放一次）：~50GB × ¥0.50 = ¥25/月
- **上述存储数字只作量级草案**。正式预算必须按真实压缩格式、回放流量、冗余/版本、删除保留策略和 300 名月付用户 × ¥38 标价对应的实际商店净收入重算，不能继续沿用旧 ¥6.9 价格，也不能把持续增长的存储成本写成“可忽略”。

随着用户量增长会自然增长，但占比始终低（< 5% 收入）。

### CDN 决策

- 1000 付费用户以内：不用 CDN，直接 OSS 公网出（用 Aliyun OSS 自带的"全球加速"开关即可）
- 1000+ 用户：上 Aliyun CDN 或 Cloudflare（[optimization.md P12](optimization.md#p12--静态资源--音频走-oss--cdn-出口)）

---

## 落地顺序建议

按"用户价值 + 工程依赖"排：

### Phase α：基础设施（2-3 周）

**M1（IAP）→ M2（用量限制）→ M6（Paywall）**

完成后：免费用户撞限制能买、能拿到付费权限、订阅状态服务端权威。**这套上线就能开始收钱**——不依赖云存储和跨端同步，付费用户暂时跟免费用户一样存本地，只是没限制。

### Phase β：差异化价值（2-3 周）

**M3（云端音频）→ M4（跨设备同步）**

完成后：付费用户真正"换手机不丢历史"、"听写跨设备无缝"。这是用户感知付费价值最强的部分。

⚠️ M3 + M4 必须配套——只做 M3 不做 M4 的话，付费用户的数据还是只在一个设备上，换手机依然丢；只做 M4 不做 M3 的话，音频文件还在本地不能跨设备播。

### Phase γ：运营 + 增长

**M5（优惠码）→ M7（用量统计）**

M5 是发布前 1 周配置；M7 是发布后边跑边搭。

---

## 跟 optimization.md 的交叉点

| 本文档 | optimization.md | 交叉关系 |
|---|---|---|
| M3（云端音频） | P3 + P4 + P12 + P24 | M3 是产品功能，P3/4/12/24 是它的非功能基础设施。做 M3 必然顺手把这几项做了 |
| M2（用量限制） | P16（per-user 配额） | 数据模型类似（Redis 计数器），可共享 |
| M2 + 用户量爆炸 | P2（异步化 + worker） | 付费用户开放后并发会上来，P2 的紧迫性会跟着升 |
| M4（跨端同步） | Q4（数据上云策略决策） | Q4 是开放决策，本文档**关闭了**——选择上云作为付费层核心价值 |
| M7（管理后台） | P22（Admin 后台） | M7 是 P22 的子集，可合并 |
| M1 IAP receipt 验证 | P1（监控） | Apple webhook 失败 / 异常 receipt 要进 Sentry |

**关键提示**：本文档的 M3 + M4 是 optimization.md 里 P3/P4/P12/P24 几个长期项的**强催化**。Phase α 可以先以“不限个人练习”为持续权益收费；一旦付费页开始承诺“跨设备不丢”，M3 + M4 就必须同时完成、通过恢复/删除测试后再发布，不能只上线其中一半。

---

## 待决策的开放问题

跑商业化之前要明确的几件事：

### Q1 · 试用机制
免费层 5 次/月就是"试用"还是需要单独的 7 天免费试用期？
- 苹果对订阅有 "Introductory Offer"（首期免费/低价）配置，可以走那条路
- 当前定价里没有显式试用——5 次本身就够了
- 建议：**先不上试用**，5 次就是事实试用

### Q2 · 已有用户从免费切付费的时序
20 个内测用户当前数据全在本地。上付费版后：
- 选项 A：内测用户**默认免费版** + 优惠码升级路径
- 选项 B：感谢内测，**送 3-6 个月付费**作为补偿
- 建议：**B**——20 个用户成本忽略不计，关系价值远高于
- 操作：App Store Connect 配 "Free for 6 months" Offer Code，专门给内测用户

### Q3 · 退款 / 取消订阅后的数据保留
付费用户取消后云端数据怎么处理？
- 选项 A：立刻删除（数据敏感型 app 的做法）
- 选项 B：保留 30 天 grace period，期间能重新订阅恢复
- 选项 C：永久保留，免费用户只是不能新创建（不建议；成本、隐私和删除义务都会无限增长）
- 建议：**B，但从权益到期后开始计算且提前提醒用户**。30 天内只读/可恢复；到期后删除云端媒体，学习元数据按隐私政策设定更短或明确的保留期。用户主动注销时仍走注销删除流程，不能等待 grace period。

### Q4 · 多平台支付（Android 未来）
现阶段 iOS only，未来上 Android 后：
- Google Play Billing 跟 Apple IAP 数据模型不同
- 需要服务端抽象一层 `subscription_provider: 'apple' | 'google'`
- 建议：**预留字段**但不实现，到时候再说

### Q5 · 内容审核（合规）
付费上架后用户量会涨，照片 / 录音内容审核必须做：
- 见 [optimization.md P20](optimization.md#p20--内容安全--moderation)
- **必须在 App Store 正式审核前做完**，否则首次提审就会被拒
- 建议：上 Aliyun 内容安全（视觉 + 文本 + 语音），价格不贵

---

## 备注

- 商业化是个**和工程并行的事**——M1-M6 写代码的同时，App Store 上架准备、隐私政策更新、订阅条款页、客服邮件模板这些非编码工作量也不小，至少给自己留 1 周
- Phase α 完成（M1+M2+M6）就能上线收钱，**不要等到 M4 全做完**再发——付费版越早收到真实反馈越好
- 不要 hard sell。PhotoSpeak 是学习类 app，付费动机来自"真的有用 + 想继续用"，paywall 触发时机要克制
