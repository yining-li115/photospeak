# PhotoSpeak — Product Requirements Document

## 产品概述

用户每天随机抽取或手动选择手机相册中的一张照片，用英语口头描述约1分钟，App 自动完成转录、纠错、生成 Polished Version、转为音频、拆解语言 Chunks 并入 SRS 卡片库，形成完整的英语口语学习闭环。

---

## 完整 Pipeline

```
① 选照片（手动 / 随机抽取）          ← Session 内
        ↓
② 录音（App 内，约1分钟）            ← Session 内
        ↓
③ STT：录音 → 文字
        ↓
④ LLM 分析：照片 + 文字 → 纠错版 / Polished Version / Chunks
        ↓
⑤ Session 界面呈现结果，用户可追问 AI
        ↓
⑥ 用户点「确认生成」
        ↓
⑦ TTS：Polished Version → 音频（按句切割）→ 进入听力库
        ↓
⑧ SRS 卡片：Chunks 自动入库 → 进入卡片库，每日推送复习
```

### Pipeline 架构说明

本产品的 pipeline 是**线性确定的**，每一步顺序固定，不需要模型自主决策下一步，因此采用 **Pipeline 架构**而非 Agent 架构。

技术上使用 **LangGraph** 搭建，原因：
- 每个节点（STT / LLM / TTS）独立封装，方便单独替换模型
- 任意节点失败可单独重试，不需要整个流程重跑
- 未来如需扩展 Agent 逻辑（如动态决策纠错策略），无需重构

---

## 各模块详细设计

---

### 模块一：照片选取

**功能：**
- 授权访问系统相册后，App 随机抽取一张照片
- 用户也可以手动浏览相册自己选择
- 照片仅在本次 Session 使用，同时作为 SRS 卡片的记忆锚点缩略图

**技术实现：**
- iOS：PHPhotoLibrary API
- Android：MediaStore API
- React Native：expo-image-picker（跨平台）

**无需外部模型。**

---

### 模块二：录音

**功能：**
- App 内一键录音，无需跳转其他 App
- 录音时长建议约1分钟，不强制限制
- 录音结束后可回听，确认后提交

**技术实现：**
- iOS：AVAudioSession
- Android：MediaRecorder
- React Native：expo-av（跨平台）
- 输出格式：16kHz 单声道 WAV 或 M4A（Whisper 推荐格式）

**无需外部模型。**

---

### 模块三：STT（语音转文字）

**目标：** 准确识别非母语口音英语，容忍口误和停顿。

#### 选项 A：OpenAI Whisper API（推荐首选）
- 对非母语口音识别率最高，是目前最佳选项
- 支持自动标点
- API 调用：`$0.006 / 分钟`，1分钟录音约 $0.006
- 延迟：约 2-5 秒
- 缺点：需联网，有隐私考量

#### 选项 B：Whisper 本地部署
- 完全离线，隐私最好
- 模型大小：tiny（75MB）/ base（145MB）/ small（466MB）
- 推荐 small 模型，在手机端精度和速度较平衡
- 缺点：手机端推理速度慢，1分钟录音可能需要10-30秒处理
- 适合后期隐私敏感用户的可选项

#### 选项 C：Google Speech-to-Text API
- 精度稍低于 Whisper，但延迟更低（约1秒）
- 价格：$0.016 / 分钟（标准模型）
- 与 Google 生态集成方便
- 缺点：对非母语口音识别稍弱

#### 选项 D：Azure Speech-to-Text
- 精度与 Whisper 接近
- 支持实时流式转录（延迟极低）
- 价格：$0.016 / 分钟
- 与 Azure 生态集成方便

**建议：** 早期使用 Whisper API，上线后根据成本和用户反馈考虑是否切换。

---

### 模块四：LLM 分析（核心模块）

**输入：**
- 照片（图片文件）
- 用户的转录文字

**输出（结构化 JSON）：**

```json
{
  "corrected": {
    "sentences": [
      {
        "original": "There have a lot of people in the photo.",
        "corrected": "There are a lot of people in the photo.",
        "error_type": "grammar",
        "explanation": "'There have' 不正确，描述存在用 'There are'",
        "is_common_for_chinese_speakers": true
      }
    ]
  },
  "polished_version": {
    "sentences": [
      "The photo captures a lively street scene.",
      "Several people are walking along the sidewalk.",
      "In the background, you can see a row of shops."
    ]
  },
  "chunks": [
    {
      "chunk": "captures a lively scene",
      "usage_note": "用 'capture' 描述照片/画面呈现某种氛围，比 'show' 更生动",
      "examples": [
        "This photo captures a peaceful moment in the park.",
        "The painting captures the chaos of city life."
      ]
    }
  ]
}
```

#### 选项 A：Claude 3.5 Sonnet / Claude 3.7（推荐首选）
- 纠错质量和 Chunk 提取质量目前最佳
- 原生支持图片输入（Vision）
- 对语言细节的解释更准确，适合教学场景
- API：约 $0.003 / 次调用（按 token 计费，每次 session 约1000 tokens）
- 缺点：无法实时对话，适合异步分析场景（本产品正是如此）

#### 选项 B：GPT-4o
- 综合能力与 Claude 接近
- 原生多模态，Vision 支持成熟
- 价格与 Claude 相近
- 更适合需要实时对话的产品形态（本产品暂不需要）

#### 选项 C：Gemini 1.5 Pro / Gemini 2.0
- Google 最新多模态模型
- 对图片理解能力强
- 价格更低：约 $0.00125 / 次调用
- 语言教学场景的纠错质量略逊于 Claude
- 适合成本敏感阶段使用

#### 选项 D：本地开源模型（Qwen2.5-VL / LLaVA）
- 完全离线，隐私最好，边际成本为零
- Qwen2.5-VL 支持中文母语者英语纠错场景
- 缺点：手机端无法运行大模型，需要自建服务器
- 适合规模化后降低 API 成本

**建议：** 首选 Claude，Gemini 作为备选（成本降低约60%）。关键决策点：如果上线后纠错质量反馈不佳，切换模型前先优化 Prompt。

**Prompt 设计原则：**
- 系统 Prompt 明确指定用户为中文母语者
- 要求标注哪些错误是中文母语者高频错误
- 要求 Polished Version 按句子输出，便于后续 TTS 切割
- 要求 Chunks 控制在3-5个，选最有迁移价值的表达

---

### 模块五：TTS（文字转音频）

**目标：** 生成适合反复听、跟读的学习音频，咬字清晰，语速稳定，慢速不失真。

**关键设计：** Polished Version 按句子切割，每句生成独立音频文件，便于播放器实现单句循环，无需做复杂的时间轴对齐。

#### 选项 A：ElevenLabs（推荐首选）
- 音质最接近真人 Podcast，市场上天花板级别
- 推荐声音：Rachel（清晰美音）或 Aria（自然美音）
- 固定一个声音，用户耳朵会校准，长期学习效果更好
- 支持按句子独立生成
- 价格：$0.12 / 1000字符（Multilingual v2），一次 session 约200字符，成本约 $0.024
- 缺点：成本最高，API 有并发限制

#### 选项 B：OpenAI TTS（tts-1-hd）
- NaturalReader Pro 的底层模型之一
- 音质略逊于 ElevenLabs，但差距不大
- 价格：$0.030 / 1000字符，成本约 $0.006 / session
- 声音选择少（6种），推荐 Nova（女声清晰）或 Onyx（男声沉稳）
- 稳定性高，延迟低

#### 选项 C：Google WaveNet / Google TTS
- 音质中等，略有机械感
- 价格便宜：$0.016 / 1000字符
- 适合成本敏感阶段

#### 选项 D：Azure Neural TTS
- 支持 SSML，可精确控制发音、停顿、重音
- 音质稳定，"播报感"略强，不如 ElevenLabs 自然
- 价格：$0.016 / 1000字符
- 如果后期需要对特定单词做发音强调（教学功能扩展），SSML 支持是优势

#### 选项 E：本地 TTS（Kokoro / XTTS）
- 开源，部署在服务器后边际成本极低
- Kokoro 是目前开源 TTS 中音质最好的
- 缺点：需要维护服务器，音质仍不如 ElevenLabs
- 适合规模化后降低成本

**建议：** 早期使用 ElevenLabs，用音质建立产品口碑。规模化后评估是否切换 OpenAI TTS 或本地方案。

---

### 模块六：播放器

**功能：**
- 句子级文字 + 音频同步高亮
- 单句循环：点击任意句子进入循环播放
- 速度调节：0.75x / 1x / 1.25x
- 回听原始录音（与 Polished Version 对比）

**技术实现：**
- 因为每句是独立音频文件，单句循环直接重复播放该文件，无需时间轴
- 高亮同步：维护一个"当前播放句子 index"的状态
- 速度调节：expo-av 原生支持 playbackRate

**无需外部模型。**

---

### 模块七：SRS 卡片系统

**功能：**
- Chunks 分析完成后自动入库，无需手动操作
- 卡片正面：Chunk 本身 + 来源照片缩略图（情境记忆锚点）
- 卡片背面：用法说明 + 2个例句 + 例句朗读音频
- 内置间隔重复算法，每日推送到期卡片
- 用户可手动标记"已掌握 / 还需练习"

**算法选择：**

#### 选项 A：FSRS 算法（推荐）
- 比传统 SM-2 更现代，记忆预测更准确
- Anki 新版已采用 FSRS
- 开源实现多，Python / JS 均有

#### 选项 B：SM-2 算法
- 经典算法，Anki 原版使用
- 实现简单，效果经过长期验证
- 适合快速原型

**例句朗读音频：**
- 在 LLM 生成 Chunk 时，例句同步发送给 TTS 生成音频
- 每个 Chunk 的2个例句各生成一个音频文件，存本地

**数据存储：**
- 本地优先：SQLite + 文件系统
- 数据结构：

```
Card {
  id
  chunk
  usage_note
  examples: [{text, audio_path}]
  photo_thumbnail_path
  source_session_id
  created_at
  next_review_at
  review_history: [{date, rating}]
}
```

---

## UI 设计

### 导航结构

底部导航栏 4 个 Tab，从左到右：

```
[ Session ] [ 听力库 ] [ 卡片库 ] [ 主页 ]
```

---

### Tab 1 — Session

**列表页：**
- 历史 session 列表，每条显示：日期 + 照片缩略图 + 前几个 chunks
- 右上角「+」按钮，进入新建 Session 流程

**新建 Session 流程（同一界面内连续完成）：**

```
① 选照片
   ├─ 「随机抽取」按钮（授权相册后随机抽一张）
   └─ 「手动选择」按钮（浏览相册自选）

② 照片确认后，出现录音按钮
   └─ 按住录音 → 松手提交

③ Pipeline 自动运行，界面显示进度
   └─ 转录中... → 分析中...

④ 结果以 chatbot 形式呈现
   ├─ AI 返回纠错版（逐句对比，标注错误原因）
   ├─ Polished Version（完整段落）
   └─ Chunks（3-5个，含用法说明 + 例句）

⑤ 用户可在此追问 AI
   └─ 例："这个错误为什么？" / "这个 chunk 还有什么例子？"

⑥ 用户点「确认生成」
   └─ 后台生成 Podcast 音频 + Chunks 入卡片库
   └─ 完成后提示：「已加入听力库 / 已生成 X 张卡片」
```

**历史 Session 详情页：**
- 点击任意历史 session，可回看完整对话内容
- 可从这里跳转到对应的播放器

---

### Tab 2 — 听力库

- 历史 session 生成的 Podcast 列表
- 每条显示：照片缩略图 + 日期 + 音频时长
- 点击进入播放器界面

**播放器功能：**
- 句子级文字 + 音频同步高亮
- 单句循环（点击任意句子进入循环）
- 速度调节：0.75x / 1x / 1.25x
- 可回听原始录音（与 Polished Version 对比）

---

### Tab 3 — 卡片库

- 今日待复习卡片数量提示
- 卡片正面：Chunk + 来源照片缩略图
- 卡片背面：用法说明 + 2个例句 + 朗读音频
- 用户评分：「还需练习 / 已掌握」，驱动 FSRS 算法计算下次复习时间
- 每日推送到期卡片通知

---

### Tab 4 — 主页（Dashboard）

- 连续练习天数（打卡 Streak）
- 本周 / 本月累计听力时长
- 累计生成卡片数 / 已掌握卡片数
- 复习完成率

---

### 设计原则

- **简洁流畅**：核心路径（选照片→录音→看结果）无多余跳转
- **零摩擦**：录完音自动触发 pipeline，用户不需要手动触发每一步
- **确认后再生成**：TTS 和卡片在用户确认后才生成，避免资源浪费
- **按需 AI 交互**：追问入口存在但不强制，不打断主流程

---

## 技术栈总览

| 层级 | 技术选择 | 备注 |
|------|---------|------|
| 移动端框架 | React Native + Expo | iOS + Android 一套代码 |
| 录音 | expo-av | 跨平台 |
| 相册访问 | expo-image-picker | 跨平台 |
| Pipeline 框架 | LangGraph | 节点独立、可单独重试、易扩展 |
| STT | OpenAI Whisper API | 首选 |
| LLM 分析 | Claude API（Vision） | 首选 |
| TTS | ElevenLabs API | 首选 |
| SRS 算法 | FSRS | 首选 |
| 本地存储 | SQLite（expo-sqlite） | 离线优先 |
| 后端（早期） | 可无后端，全部客户端直连 API | 降低复杂度 |
| 后端（上线后） | Node.js / FastAPI | 管理 API Key、用户数据 |

---

## 成本估算（单次 Session）

| 步骤 | 服务 | 单次成本 |
|------|------|---------|
| STT | Whisper API | ~$0.006 |
| LLM 分析 | Claude API | ~$0.003 |
| TTS（正文） | ElevenLabs | ~$0.024 |
| TTS（例句音频） | ElevenLabs | ~$0.012 |
| **合计** | | **~$0.045 / session** |

如切换 OpenAI TTS 替代 ElevenLabs，单次成本降至约 **$0.015**。

---

## 各模块模型替换决策树

```
纠错/Chunk质量不好？
  → 先优化 Prompt
  → Prompt 优化无效 → 换模型（GPT-4o / Gemini）

TTS 音质不好？
  → 换声音（同一平台内）
  → 换平台（ElevenLabs → OpenAI TTS）

STT 识别率差？
  → 先检查录音质量（采样率/噪音）
  → 换模型（Whisper large / Azure STT）

成本太高？
  → TTS 换 OpenAI TTS（节省最多）
  → LLM 换 Gemini（节省约60%）
```

---

## 开发优先级建议

**Phase 1（跑通 Pipeline）**
1. 相册访问 + 录音
2. Whisper 转录
3. Claude 分析 + 结构化 JSON 输出
4. ElevenLabs TTS 按句生成
5. 基础播放器（单句循环）

**Phase 2（完善体验）**
6. SRS 卡片系统
7. 每日推送
8. 播放器优化（速度调节、高亮同步）

**Phase 3（上线准备）**
9. 用户系统 + 后端
10. 数据分析（用户使用情况、模型效果监控）
11. 定价和订阅系统

---

*文档版本：v0.2 | 2026年4月*
