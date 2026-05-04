/**
 * Public-facing legal pages: privacy policy + terms of service.
 *
 * Apple's App Store Connect submission flow asks for a publicly
 * reachable Privacy Policy URL — we serve it from the backend so we
 * have one URL we control and can update without a new app build.
 */

const LAST_UPDATED = '2026-05-05';
const SUPPORT_EMAIL = 'heyyiru@gmail.com';

export function privacyHtml(): string {
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
  <li><strong>使用统计</strong>：每日学习次数、收听时长、复习卡片数量等聚合统计，仅用于在 app 内向您展示。</li>
</ol>

<h3>三、我们如何使用这些信息</h3>
<ol>
  <li>账号信息用于识别和恢复您的账号，不会用于推送广告或第三方营销。</li>
  <li>学习内容仅用于：(a) 向第三方 AI 服务商发送以生成分析、改写、语音；(b) 在您的设备本地存储以便复习。</li>
  <li>第三方服务商：
    <ul>
      <li><strong>小米 MiMo</strong>（图像理解 + 文本分析 + 语音合成）—— <a href="https://platform.xiaomimimo.com">platform.xiaomimimo.com</a></li>
      <li><strong>阿里云 DashScope</strong>（语音转文字）—— <a href="https://dashscope.aliyun.com">dashscope.aliyun.com</a></li>
      <li>这些服务商承诺不会将您的内容用于模型训练或其他商业用途。</li>
    </ul>
  </li>
</ol>

<h3>四、数据存储与传输</h3>
<ol>
  <li>账号信息存储于位于中华人民共和国境内的服务器（阿里云上海地域），以 PostgreSQL 数据库保存。</li>
  <li>学习内容（照片、录音、生成的音频文件）<strong>仅存储于您本地设备</strong>，不上传至我们的服务器。</li>
  <li>所有 API 请求通过 HTTPS（TLS 1.2+）加密传输。</li>
</ol>

<h3>五、您的权利</h3>
<ol>
  <li><strong>注销账号</strong>：在 app 内的"账号"页面点击"注销账号"。注销后账号进入 7 天冷静期，期间重新登录可恢复；冷静期满后服务器侧账号信息将被永久删除。</li>
  <li><strong>查询和更正</strong>：在 app 内"账号"页面修改昵称。如需查询或更正其他信息，请发邮件至 <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>。</li>
  <li><strong>本地数据清理</strong>：在 iOS"设置 → 通用 → iPhone 储存空间 → PhotoSpeak"中卸载 app 即可清空所有本地学习内容。</li>
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
  <li><strong>Usage statistics</strong>: Aggregate counts (daily session count, listening time, cards reviewed) shown back to you in-app.</li>
</ol>

<h3>3. How we use it</h3>
<ol>
  <li>Account info is used to identify and recover your account. We don't sell or share it for marketing.</li>
  <li>Learning content is sent to (a) AI services for analysis / TTS / ASR; (b) stored on your device for review.</li>
  <li>Third-party services:
    <ul>
      <li><strong>Xiaomi MiMo</strong> (image+text analysis, TTS)</li>
      <li><strong>Aliyun DashScope</strong> (speech-to-text)</li>
      <li>These vendors commit to not using your content for model training or other commercial purposes.</li>
    </ul>
  </li>
</ol>

<h3>4. Storage and transit</h3>
<ol>
  <li>Account info is stored on servers located in the People's Republic of China (Aliyun, Shanghai region) in a PostgreSQL database.</li>
  <li>Learning content (photos, recordings, generated audio) <strong>stays on your device</strong> and is not uploaded to our servers.</li>
  <li>All API traffic is encrypted via HTTPS (TLS 1.2+).</li>
</ol>

<h3>5. Your rights</h3>
<ol>
  <li><strong>Delete account</strong>: In-app, Account → Delete account. The account enters a 7-day cooldown; signing in again during that window restores it. After 7 days the server-side account is permanently removed.</li>
  <li><strong>Access and correction</strong>: Edit your nickname in-app. For other queries email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</li>
  <li><strong>Local data wipe</strong>: Uninstalling the app from iOS Settings clears all on-device learning content.</li>
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
