/**
 * Smoke test: boots the backend on a test port and drives two WebSocket
 * clients through the full lifecycle:
 *   join -> searching -> matched -> text/image chat -> abrupt disconnect
 *   -> reconnect with session restore -> report -> clean shutdown.
 *
 * Run: npm test  (from backend/, after `npm install`)
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const PORT = 8091;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.error(`  FAIL ${name}`); }
}

function waitFor(ws, predicate, label, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`timeout waiting for: ${label}`));
    }, timeoutMs);
    const onMsg = (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (predicate(m)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(m);
      }
    };
    ws.on('message', onMsg);
  });
}

async function waitHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      const j = await res.json();
      if (j.ok) return j;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('server did not become healthy');
}

async function main() {
  console.log('Spawning backend on :' + PORT);
  const server = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(PORT), ALLOWED_ORIGINS: '*' },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  try {
    await waitHealth();
    console.log('Backend is healthy.\n');

    // --- client A joins -> idle -> presses Start (next) -> searching ---
    const a = new WebSocket(WS_URL);
    await new Promise((r, j) => { a.on('open', r); a.on('error', j); });
    const welcomeP = waitFor(a, (m) => m.type === 'welcome', 'A welcome');
    a.send(JSON.stringify({ type: 'join' }));
    const welcomeA = await welcomeP;
    check('A gets welcome with userId', typeof welcomeA.userId === 'string' && welcomeA.userId.startsWith('Guest-'));
    await waitFor(a, (m) => m.type === 'idle', 'A idle (not auto-queued)');
    check('A is idle until Start is pressed', true);

    const searchingAP = waitFor(a, (m) => m.type === 'searching', 'A searching');
    a.send(JSON.stringify({ type: 'next' }));
    await searchingAP;
    check('A enters queue after next', true);

    // --- client B joins and presses Start -> both matched ---
    const b = new WebSocket(WS_URL);
    await new Promise((r, j) => { b.on('open', r); b.on('error', j); });
    const matchedA = waitFor(a, (m) => m.type === 'matched', 'A matched');
    const matchedB = waitFor(b, (m) => m.type === 'matched', 'B matched');
    const welcomeB = await new Promise((resolve) => {
      const wp = waitFor(b, (m) => m.type === 'welcome', 'B welcome');
      b.send(JSON.stringify({ type: 'join' }));
      wp.then(resolve);
    });
    b.send(JSON.stringify({ type: 'next' }));
    const [mA, mB] = await Promise.all([matchedA, matchedB]);
    check('A and B matched into same session', mA.sessionId === mB.sessionId);
    check('A sees B as partner', mA.partner.userId === welcomeB.userId);

    // --- text chat A -> B ---
    const chatAtA = waitFor(a, (m) => m.type === 'chat' && m.message.kind === 'text', 'A echo');
    const chatAtB = waitFor(b, (m) => m.type === 'chat' && m.message.kind === 'text', 'B receives text');
    a.send(JSON.stringify({ type: 'chat', kind: 'text', text: 'Hello there!' }));
    const [echo, got] = await Promise.all([chatAtA, chatAtB]);
    check('B receives text message', got.message.text === 'Hello there!' && got.message.from === welcomeA.userId);
    check('sender gets own echo', echo.message.text === 'Hello there!');

    // --- image chat B -> A ---
    const tinyImg = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const imgAtA = waitFor(a, (m) => m.type === 'chat' && m.message.kind === 'image', 'A receives image');
    b.send(JSON.stringify({ type: 'chat', kind: 'image', src: tinyImg }));
    const imgMsg = await imgAtA;
    check('A receives image message', imgMsg.message.src === tinyImg);

    // --- voice chat A -> B ---
    const tinyAudio = 'data:audio/webm;base64,' + Buffer.from('fake-webm-bytes').toString('base64');
    const voiceAtB = waitFor(b, (m) => m.type === 'chat' && m.message.kind === 'voice', 'B receives voice');
    a.send(JSON.stringify({ type: 'chat', kind: 'voice', src: tinyAudio, dur: 3 }));
    const voiceMsg = await voiceAtB;
    check('B receives voice message', voiceMsg.message.src === tinyAudio && voiceMsg.message.dur === 3);

    // --- A drops abruptly; B notified ---
    const partnerGone = waitFor(b, (m) => m.type === 'partner_disconnected', 'B notified of disconnect');
    a.terminate();
    await partnerGone;
    check('B gets partner_disconnected with grace', true);

    // --- A reconnects with same id -> session restore with history ---
    await sleep(300);
    const a2 = new WebSocket(WS_URL);
    await new Promise((r, j) => { a2.on('open', r); a2.on('error', j); });
    const welcome2P = waitFor(a2, (m) => m.type === 'welcome', 'A2 welcome');
    const restoreP = waitFor(a2, (m) => m.type === 'session_restore', 'A2 session_restore');
    a2.send(JSON.stringify({ type: 'join', userId: welcomeA.userId }));
    await welcome2P;
    const restore = await restoreP;
    check('A restores same session', restore.sessionId === mA.sessionId);
    check('history restored (>=3 msgs)', Array.isArray(restore.history) && restore.history.length >= 3);
    const kinds = restore.history.map((h) => h.kind);
    check('history contains text+image+voice', kinds.includes('text') && kinds.includes('image') && kinds.includes('voice'));
    const bNotified = await waitFor(b, (m) => m.type === 'partner_reconnected', 'B sees reconnect');
    check('B gets partner_reconnected', !!bNotified);

    // --- B reports A -> ack ---
    const ack = waitFor(b, (m) => m.type === 'report_ack', 'report ack');
    b.send(JSON.stringify({ type: 'report', reason: 'harassment' }));
    await ack;
    check('report acknowledged', true);

    // --- B presses next -> A gets session_ended and searching ---
    const endedAtA = waitFor(a2, (m) => m.type === 'session_ended', 'A session_ended');
    const searchingA = waitFor(a2, (m) => m.type === 'searching', 'A re-queued');
    b.send(JSON.stringify({ type: 'next' }));
    await Promise.all([endedAtA, searchingA]);
    check('partner_left ends session and re-queues A', true);

    // --- health reflects state ---
    const h = await (await fetch(`${BASE}/health`)).json();
    check('health endpoint reports counts', typeof h.clients === 'number' && typeof h.queue === 'number');

    a2.close(); b.close();
    await sleep(200);
  } catch (err) {
    failures++;
    console.error('  FAIL unexpected error:', err.message);
    console.error('--- server log ---\n' + serverLog);
  } finally {
    server.kill();
    await sleep(300);
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
