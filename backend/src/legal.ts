/**
 * Public-facing legal pages: privacy policy + terms of service.
 *
 * Apple's App Store Connect submission flow asks for a publicly
 * reachable Privacy Policy URL — we serve it from the backend so we
 * have one URL we control and can update without a new app build.
 */

const LAST_UPDATED = '2026-09-22';
const SUPPORT_EMAIL = 'heyyiru@gmail.com';

export interface LegalProviderConfig {
  aiProviderName?: string;
  aiProviderUrl?: string;
  diagnosticsRegion?: string;
  diagnosticsRetentionDays?: number;
}

export function privacyHtml(config: LegalProviderConfig = {}): string {
  const aiProviderName = escapeHtml(
    config.aiProviderName?.trim().slice(0, 100) || 'AI service provider'
  );
  const aiProviderUrl = safeHttpsUrl(config.aiProviderUrl);
  const aiProviderWebsite = aiProviderUrl
    ? `<a href="${aiProviderUrl}">服务商网站</a>`
    : '服务商信息以应用内当前政策为准';
  const aiProviderWebsiteEnglish = aiProviderUrl
    ? `<a href="${aiProviderUrl}">provider website</a>`
    : 'see the current in-app policy';
  const diagnosticsRegion = escapeHtml(
    config.diagnosticsRegion?.trim().slice(0, 100) ||
      'the region configured for our Sentry project'
  );
  const diagnosticsRetentionDays =
    Number.isInteger(config.diagnosticsRetentionDays) &&
    (config.diagnosticsRetentionDays ?? 0) > 0
      ? config.diagnosticsRetentionDays
      : 30;
  return wrap(
    'PhotoSpeak · 隐私政策 / Privacy Policy',
    `
<h2>PhotoSpeak 隐私政策</h2>
<p class="muted">最后更新：${LAST_UPDATED}</p>

<h3>一、服务说明</h3>
<p>PhotoSpeak 是一款帮助你通过描述照片练习英语口语的应用。每天选一张照片，录一段英语，AI 自动批改、改写、生成播客和复习卡片。使用本应用即表示您接受以下条款。</p>

<h3>二、我们收集的信息</h3>
<ol>
  <li><strong>账号信息</strong>：通过 Apple ID 登录时收集 Apple 提供的用户标识符（Apple sub），如您选择共享，还包括邮箱与姓名。通过手机号登录时收集您的手机号。</li>
  <li><strong>学习内容</strong>：您选择的照片、录制的语音、对应的文本（英文转写、AI 改写后的版本、AI 生成的对话上下文）。这些内容主要保存在<strong>您的设备本地</strong>；进行 AI 分析时通过加密通道（HTTPS）传输至下述第三方服务商。</li>
  <li><strong>使用与运维统计</strong>：每日学习次数、收听时长、复习卡片数量，以及 AI 能力类型、模型标识、token 或字符数量、耗时、请求状态和订阅套餐。长期运维记录不保存照片、录音、提示词或生成正文。为避免网络重试造成重复调用和重复计费，我们会按下文所述短期保存加密的 AI 响应。</li>
  <li><strong>可选诊断数据</strong>：“发送诊断数据”默认关闭。仅在您登录后主动开启时，Sentry 才会接收崩溃堆栈、错误类型、应用/系统版本、设备类型、少量性能轨迹、事件时间及去标识化事件/设备标识。发送前会移除请求正文、认证头、照片、录音、转写、AI 正文和控制台消息正文。</li>
</ol>

<h3>三、我们如何使用这些信息</h3>
<ol>
  <li>账号信息用于识别和恢复您的账号，不会用于推送广告或第三方营销。</li>
  <li>学习内容仅用于：(a) 向第三方 AI 服务商发送以生成分析、改写、语音；(b) 在您的设备本地存储以便复习。</li>
  <li>第三方服务商：
    <ul>
      <li><strong>${aiProviderName}</strong>（图像理解、文本分析、语音合成和语音转文字）—— ${aiProviderWebsite}</li>
      <li><strong>Sentry</strong>（可选的崩溃、错误与性能诊断）—— 数据区域：${diagnosticsRegion}；诊断事件最多保留 ${diagnosticsRetentionDays} 天。您可随时在 app 的 Account 页面关闭，关闭后不再发送新事件。</li>
      <li>第三方处理范围、留存期限和是否用于改进服务，以我们与服务商适用的企业协议及其隐私政策为准。我们会在更换服务商或处理方式发生重大变化时更新本政策。</li>
    </ul>
  </li>
</ol>

<h3>四、数据存储与传输</h3>
<ol>
  <li>账号信息存储于位于中华人民共和国境内的服务器（阿里云上海地域），以 PostgreSQL 数据库保存。</li>
  <li>照片、原始录音及完整学习历史的长期副本<strong>仅存储于您的本地设备</strong>。为完成 AI 功能，照片、转写文本或待合成文本会经由我们的服务器转发至第三方服务商；请求正文不会写入业务数据库。</li>
  <li>为安全恢复中断的请求，AI 分析与追问响应会以 AES-256-GCM 加密形式最多保留 72 小时，语音合成响应最多保留 24 小时。为防止旧请求在未来被重复执行和计费，仅含不可逆请求键摘要、键控内容哈希及运行状态的去重记录会保留：新版请求通常在 400 天拒绝期及 7 天安全余量后分批删除，内测旧版请求则保留至账号永久删除；其中不含照片、录音、转写、提示词或生成正文。上述数据只用于安全重放和防重复计费，不用于训练、广告或建立云端学习档案。</li>
  <li>启用诊断时，诊断事件经 TLS 传输至上述 Sentry 区域，并按上述期限自动删除。关闭开关不会影响登录、练习、AI 或订阅功能。</li>
  <li>所有 API 请求通过 HTTPS（TLS 1.2+）加密传输。</li>
</ol>

<h3>五、您的权利</h3>
<ol>
  <li><strong>注销账号</strong>：在 app 内的"账号"页面点击"注销账号"。本机学习内容会立即且不可恢复地删除；服务器账号进入 7 天冷静期，期间重新登录可恢复账号（不恢复已删除的本机内容）；冷静期满后服务器侧账号信息将被永久删除。</li>
  <li><strong>查询和更正</strong>：在 app 内"账号"页面修改昵称。如需查询或更正其他信息，请发邮件至 <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>。</li>
  <li><strong>本地数据清理</strong>：在 iOS"设置 → 通用 → iPhone 储存空间 → PhotoSpeak"中卸载 app 即可清空所有本地学习内容。</li>
  <li><strong>诊断退出</strong>：在 app 的 Account 页面关闭“发送诊断数据”，即可立即阻止新的错误与性能事件发送；如需处理已发送事件，请通过下方邮箱联系我们。</li>
</ol>

<h3>六、用户行为规范</h3>
<ol>
  <li>禁止上传违法、淫秽、骚扰他人的内容。</li>
  <li>不得利用本应用进行任何商业用途的批量内容生成。</li>
</ol>

<h3>七、免责声明</h3>
<p>AI 生成的英语建议仅供学习参考，不保证语法绝对准确。正式书面或考试场合请人工复核。</p>

<h3>八、政策变更</h3>
<p>本政策可能更新。重大变更将通过 app 内通知或邮件方式告知。继续使用即视为接受变更后的条款。</p>

<h3>九、联系我们</h3>
<p>如有任何疑问，请联系：<a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>

<hr />

<h2>Privacy Policy (English)</h2>
<p class="muted">Last updated: ${LAST_UPDATED}</p>

<h3>1. About</h3>
<p>PhotoSpeak helps Chinese-native English learners practice spoken English by describing photos. By using the app you agree to this policy.</p>

<h3>2. Information we collect</h3>
<ol>
  <li><strong>Account info</strong>: When you sign in with Apple, we receive Apple's user identifier (and, if you choose to share, your email and name). When you sign in with phone, we receive your phone number.</li>
  <li><strong>Learning content</strong>: Photos you pick, audio you record, and the resulting transcripts / AI-polished text / AI-generated audio. These live <strong>on your device</strong>; copies are sent over encrypted HTTPS to the third-party AI services below for processing.</li>
  <li><strong>Usage and operations metadata</strong>: Learning counts shown in-app, plus AI capability, model identifier, token or character counts, latency, request status, and subscription plan. Long-term operations records do not store photos, recordings, prompts, or generated content. As described below, an encrypted AI response is retained briefly to make retries safe and avoid duplicate charges.</li>
  <li><strong>Optional diagnostics</strong>: “Send diagnostics” is off by default. Only after you sign in and actively enable it does Sentry receive crash stacks, error types, app/OS versions, device type, a small sample of performance traces, timestamps, and pseudonymous event/device identifiers. Before sending, we remove request bodies, authentication headers, photos, recordings, transcripts, AI content, and console-message bodies.</li>
</ol>

<h3>3. How we use it</h3>
<ol>
  <li>Account info is used to identify and recover your account. We don't sell or share it for marketing.</li>
  <li>Learning content is sent to (a) AI services for analysis / TTS / ASR; (b) stored on your device for review.</li>
  <li>Third-party services:
    <ul>
      <li><strong>${aiProviderName}</strong> (image and text analysis, TTS, and speech-to-text) — ${aiProviderWebsiteEnglish}</li>
      <li><strong>Sentry</strong> (optional crash, error, and performance diagnostics) — data region: ${diagnosticsRegion}; diagnostic events are retained for up to ${diagnosticsRetentionDays} days. You can disable new collection at any time in the app's Account screen.</li>
      <li>Processing scope, retention, and service-improvement use are governed by the applicable enterprise agreements and provider privacy policies. We update this policy when a provider or material processing practice changes.</li>
    </ul>
  </li>
</ol>

<h3>4. Storage and transit</h3>
<ol>
  <li>Account info is stored on servers located in the People's Republic of China (Aliyun, Shanghai region) in a PostgreSQL database.</li>
  <li>Long-term copies of photos, original recordings, and complete learning history <strong>stay on your device</strong>. To perform AI functions, a photo, transcript, or text to synthesize transits our server on its way to the listed processor; request bodies are not written to our application database.</li>
  <li>To recover interrupted requests safely, AI analysis and follow-up responses are stored with AES-256-GCM encryption for up to 72 hours, and speech-synthesis responses for up to 24 hours. To prevent an old request from being executed and charged again, an irreversible request-key digest, keyed content hash, and operational state are retained: new-version request records are normally batch-deleted after a 400-day rejection horizon plus a seven-day safety margin, while legacy beta request records remain until the account is permanently deleted. These records contain no photo, recording, transcript, prompt, or generated content and are used only for safe replay and duplicate-charge prevention, never for training, advertising, or a cloud learning archive.</li>
  <li>When diagnostics are enabled, events travel over TLS to the Sentry region above and are automatically deleted under the stated retention. Turning diagnostics off does not affect sign-in, practice, AI, or subscription features.</li>
  <li>All API traffic is encrypted via HTTPS (TLS 1.2+).</li>
</ol>

<h3>5. Your rights</h3>
<ol>
  <li><strong>Delete account</strong>: In-app, Account → Delete account. On-device learning content is deleted immediately and cannot be restored. The server account enters a 7-day cooldown; signing in again during that window restores the account, but not deleted local content. After 7 days the server-side account is permanently removed.</li>
  <li><strong>Access and correction</strong>: Edit your nickname in-app. For other queries email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</li>
  <li><strong>Local data wipe</strong>: Uninstalling the app from iOS Settings clears all on-device learning content.</li>
  <li><strong>Diagnostics opt-out</strong>: Turn off “Send diagnostics” in the app's Account screen to immediately stop new error and performance events. Contact us below about already-sent events.</li>
</ol>

<h3>6. User conduct</h3>
<ol>
  <li>No uploading illegal, obscene, or harassing content.</li>
  <li>No using the app for commercial bulk content generation.</li>
</ol>

<h3>7. Disclaimer</h3>
<p>AI-generated English suggestions are for learning reference only. Verify them manually for formal writing or exams.</p>

<h3>8. Changes to this policy</h3>
<p>This policy may change. Material changes will be communicated via in-app notice or email. Continued use means you accept the updated terms.</p>

<h3>9. Contact</h3>
<p>For any questions email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>
`
  );
}

export function termsHtml(): string {
  return wrap(
    'PhotoSpeak · 用户协议 / Terms of Service',
    `
<h2>PhotoSpeak 用户协议</h2>
<p class="muted">最后更新：${LAST_UPDATED}</p>

<h3>一、服务与账号</h3>
<ol>
  <li>PhotoSpeak 提供照片描述、语音识别、AI 英语建议、语音合成和复习工具。您应提供真实、合法的登录信息并妥善保护账号。</li>
  <li>服务面向能够依法同意本协议的用户。未成年人应在监护人同意和指导下使用。</li>
  <li>AI 输出可能不准确，仅用于语言学习参考，不构成考试、教育、医疗、法律或其他专业意见。</li>
</ol>

<h3>二、您的内容</h3>
<ol>
  <li>您保留对上传照片、录音及文字依法享有的权利，并授予我们为提供、保护和改进本次服务所必需的有限处理权限。</li>
  <li>您确认有权处理所选照片及其中人物的信息，不得上传违法、侵权、欺诈、骚扰或未经授权的敏感内容。</li>
  <li>学习内容主要保存在本机；具体处理方、用途、保留期限和删除方式见隐私政策。</li>
</ol>

<h3>三、Plus 订阅</h3>
<ol>
  <li>Plus 月付和年付均提供正常个人学习用途下不限练习次数和追问次数的权益，不显示月度次数余额。该承诺不包括 API 转售、共享账号、自动化批量生成、攻击或明显异常使用。</li>
  <li>订阅由购买所用的应用商店自动续订并收费，除非您在商店规定的续订时间前取消。取消后，权益通常持续到当前已付费周期结束；退款由适用商店按其规则处理。</li>
  <li>设备存储容量不是订阅配额。为保护手机，达到本机安全上限时，应用会要求您删除旧记录后再创建内容，并不会静默删除已完成的学习历史。</li>
  <li>价格、税费、试用或首期优惠以购买页和应用商店确认页为准。我们不会仅因价格变化而缩短已付费周期。</li>
</ol>

<h3>四、公平使用与服务保护</h3>
<ol>
  <li>我们可以使用速率、并发、成本和安全阈值阻止泄露凭据、自动化滥用或影响其他用户的行为。这些阈值是安全措施，不是正常用户的隐藏月度配额。</li>
  <li>对于异常使用，我们可以暂停新的高成本请求并要求验证账号或联系支持；除紧急安全情形外，我们会提供合理说明。</li>
</ol>

<h3>五、可用性、变更与终止</h3>
<ol>
  <li>网络、设备和第三方 AI 服务可能导致延迟或中断。我们会合理维护服务，但不保证始终无错误或不间断。</li>
  <li>您可随时停止使用或在应用内申请注销。我们可对严重违反本协议、法律或安全要求的账号限制服务。</li>
  <li>重大协议或订阅权益变更会通过应用内通知或其他合理方式告知；法律规定的消费者权利不受本协议限制。</li>
</ol>

<h3>六、联系我们</h3>
<p>如有问题，请联系：<a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>

<hr />

<h2>Terms of Service (English)</h2>
<p class="muted">Last updated: ${LAST_UPDATED}</p>

<h3>1. Service and account</h3>
<p>PhotoSpeak provides photo-description practice, speech recognition, AI language feedback, synthesized audio, and review tools. Protect your account and use the service only where you can lawfully accept these terms. AI output may be inaccurate and is for language-learning reference, not professional advice.</p>

<h3>2. Your content</h3>
<p>You retain your lawful rights in your photos, recordings, and text and grant us the limited permission needed to provide and secure the requested service. You must have the right to process uploaded content and may not submit illegal, infringing, deceptive, harassing, or unauthorized sensitive material. See the Privacy Policy for processors, retention, and deletion.</p>

<h3>3. Plus subscription</h3>
<p>Monthly and annual Plus include unlimited sessions and follow-ups for normal personal learning, with no monthly usage counter. This excludes API resale, account sharing, automated bulk generation, attacks, and clearly abnormal use. Subscriptions renew through the store used for purchase unless cancelled within that store's deadline. Cancellation normally takes effect after the paid period; the store handles refunds under its rules. Device-storage safeguards are not a subscription quota.</p>

<h3>4. Fair use and protection</h3>
<p>We may apply rate, concurrency, cost, and security controls to protect users and the service. These are anti-abuse safeguards, not a hidden monthly allowance for ordinary learners. We may pause costly operations during anomalous use and request account verification or support contact.</p>

<h3>5. Availability and termination</h3>
<p>Networks, devices, and third-party AI services can cause delay or interruption, so uninterrupted or error-free operation is not guaranteed. You may stop using or request deletion at any time. We may restrict serious violations of these terms, law, or security requirements. Mandatory consumer rights remain unaffected.</p>

<h3>6. Contact</h3>
<p>Questions: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>
`
  );
}

export function supportHtml(): string {
  return wrap(
    'PhotoSpeak · 帮助与支持 / Support',
    `
<h2>PhotoSpeak 帮助与支持</h2>
<p class="muted">我们通常会在 2 个工作日内回复。</p>

<h3>联系我们</h3>
<p>如遇登录、录音、转写、AI 分析、订阅或账号问题，请发送邮件至
<a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>。请说明设备型号、iOS 版本、App 版本和问题发生时间；请勿通过邮件发送密码、验证码、API Key、完整照片或录音。</p>

<h3>常见问题</h3>
<ul>
  <li><strong>无法录音：</strong>前往“设置 → 隐私与安全性 → 麦克风”，确认已允许 PhotoSpeak 使用麦克风。</li>
  <li><strong>无法选择照片：</strong>前往“设置 → 隐私与安全性 → 照片”，允许 PhotoSpeak 访问所选照片。</li>
  <li><strong>转写或 AI 反馈较慢：</strong>请保持 App 在前台并检查网络连接。高峰期或第三方服务波动可能造成延迟。</li>
  <li><strong>删除账号：</strong>在 App 的 Account 页面选择“注销账号”。隐私政策说明了本机数据清除和服务器端冷静期。</li>
</ul>

<h3>相关文档</h3>
<p><a href="/privacy">隐私政策 / Privacy Policy</a><br>
<a href="/terms">用户协议 / Terms of Service</a></p>

<hr />

<h2>Support</h2>
<p>Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> for help with sign-in, recording, transcription, AI feedback, subscriptions, or account deletion. Include your device model, iOS version, app version, and approximate time of the issue. Do not email passwords, verification codes, API keys, full photos, or recordings.</p>
<p>We normally reply within two business days.</p>
`
  );
}

export function landingHtml(): string {
  return wrap(
    'PhotoSpeak Daily · Speak English from photos',
    `
<h2>PhotoSpeak Daily</h2>
<p>Turn everyday photos into practical English speaking practice. Describe a photo, review your transcript and corrections, listen to a polished version, and save useful phrases for later.</p>

<h3>Practice from real life</h3>
<p>Your photos and long-term learning history stay on your device. Content needed for transcription and AI feedback is securely processed by the service providers described in our privacy policy.</p>

<p><a href="/support">Help &amp; Support</a><br>
<a href="/privacy">Privacy Policy</a><br>
<a href="/terms">Terms of Service</a></p>
`
  );
}

function wrap(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --bg: #F5F2EE;
    --card: #FAFAF8;
    --text: #1a1a1a;
    --muted: #888884;
    --accent: #C8842A;
    --separator: #e8e4de;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue",
      "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  main {
    max-width: 720px;
    margin: 32px auto;
    background: var(--card);
    padding: 32px 28px 48px;
    border-radius: 20px;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.04);
  }
  h2 { margin-top: 0; font-size: 26px; letter-spacing: -0.3px; }
  h3 { margin-top: 28px; font-size: 17px; }
  .muted { color: var(--muted); font-size: 13px; margin-top: -6px; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  ol, ul { padding-left: 22px; }
  li { margin-bottom: 6px; }
  hr {
    border: 0;
    border-top: 1px solid var(--separator);
    margin: 36px 0;
  }
  @media (max-width: 480px) {
    main { margin: 0; padding: 24px 18px 36px; border-radius: 0; }
    h2 { font-size: 22px; }
  }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeHttpsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      ? escapeHtml(parsed.toString())
      : undefined;
  } catch {
    return undefined;
  }
}
