/**
 * One-shot end-to-end verification for the streaming-ASR upstream
 * path. Run with the backend's .env loaded so DASHSCOPE_API_KEY is
 * present. Does NOT print the key or the temp token; only status
 * and shape checks.
 *
 * Verifies:
 *   1. POST /api/v1/tokens?expire_in_seconds=300 returns a token
 *   2. wss://...api-ws/v1/inference accepts that token (handshake)
 *   3. run-task with model=paraformer-realtime-v2 gets task-started
 *
 * Doesn't send actual PCM — task-started is sufficient to prove the
 * protocol contract; the audio path is dominated by transport, not
 * negotiation.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';

const KEY = process.env.DASHSCOPE_API_KEY;
if (!KEY) {
  console.error('DASHSCOPE_API_KEY not in env — run from backend/ with .env present');
  process.exit(2);
}

const TOKEN_URL = 'https://dashscope.aliyuncs.com/api/v1/tokens?expire_in_seconds=300';
const WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';

function log(label, ...rest) {
  console.log(`[verify] ${label}`, ...rest);
}

// ─── Step 1: get temp token ───────────────────────────────────────
log('step 1: requesting temp token from DashScope…');
const t0 = Date.now();
const tokenRes = await fetch(TOKEN_URL, {
  method: 'POST',
  headers: { Authorization: `Bearer ${KEY}` },
});
const tokenLatency = Date.now() - t0;

if (!tokenRes.ok) {
  const body = await tokenRes.text().catch(() => '');
  log(`✗ token request failed: HTTP ${tokenRes.status} (${tokenLatency}ms)`);
  log('upstream body:', body.slice(0, 500));
  process.exit(1);
}

const tokenJson = await tokenRes.json();
const tempToken = tokenJson.token;
if (typeof tempToken !== 'string' || !tempToken.startsWith('st-')) {
  log('✗ token response shape unexpected — got keys:', Object.keys(tokenJson));
  process.exit(1);
}
log(`✓ token received (${tokenLatency}ms, prefix="${tempToken.slice(0, 3)}", len=${tempToken.length}, expires_at=${tokenJson.expires_at})`);

// ─── Step 2: WebSocket handshake with the temp token ──────────────
log('step 2: opening WebSocket to DashScope with temp token…');
const ws = new WebSocket(WS_URL, {
  headers: { Authorization: `Bearer ${tempToken}` },
});

const taskId = randomUUID().replace(/-/g, '');
let stage = 'connect';

const done = new Promise((resolve, reject) => {
  const failTimer = setTimeout(() => {
    reject(new Error(`timeout at stage=${stage} after 15s`));
  }, 15000);

  ws.addEventListener('open', () => {
    log(`✓ WS open`);
    stage = 'run-task';
    log('step 3: sending run-task for paraformer-realtime-v2…');
    ws.send(
      JSON.stringify({
        header: {
          action: 'run-task',
          task_id: taskId,
          streaming: 'duplex',
        },
        payload: {
          task_group: 'audio',
          task: 'asr',
          function: 'recognition',
          model: 'paraformer-realtime-v2',
          parameters: {
            format: 'pcm',
            sample_rate: 16000,
            language_hints: ['en', 'zh'],
          },
          input: {},
        },
      })
    );
  });

  ws.addEventListener('message', (ev) => {
    if (typeof ev.data !== 'string') return;
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    const event = msg.header?.event;
    log(`  server event: ${event}`);
    if (event === 'task-started') {
      log('✓ task-started — protocol contract OK');
      // Send finish-task to close cleanly. Task with no audio
      // frames sometimes finalises with task-failed (CLIENT_ERROR
      // timeout), which is fine — we already proved the
      // handshake.
      ws.send(
        JSON.stringify({
          header: {
            action: 'finish-task',
            task_id: taskId,
            streaming: 'duplex',
          },
          payload: { input: {} },
        })
      );
      clearTimeout(failTimer);
      // Don't wait for task-finished — that requires audio. Resolve here.
      setTimeout(() => {
        try {
          ws.close();
        } catch {}
        resolve();
      }, 200);
    } else if (event === 'task-failed') {
      clearTimeout(failTimer);
      reject(
        new Error(
          `task-failed at stage=${stage}: ${msg.header?.error_code} — ${msg.header?.error_message}`
        )
      );
    }
  });

  ws.addEventListener('error', () => {
    // RN-style; node's WS gives more in 'close'
  });

  ws.addEventListener('close', (ev) => {
    if (stage === 'run-task' || stage === 'connect') {
      clearTimeout(failTimer);
      reject(new Error(`WS closed at stage=${stage}: code=${ev.code} reason=${ev.reason}`));
    }
  });
});

try {
  await done;
  log('────────────────────────────────────────');
  log('OK — full upstream chain works:');
  log('  • temp token endpoint reachable + returns st-* tokens');
  log('  • paraformer-realtime-v2 WS accepts the temp token');
  log('  • run-task with our exact JSON shape gets task-started');
  process.exit(0);
} catch (err) {
  log('────────────────────────────────────────');
  log('✗ FAILED:', err.message);
  process.exit(1);
}
