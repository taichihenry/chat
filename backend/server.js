'use strict';

/**
 * RandomChat — WebSocket backend for real-time random pairing chat.
 *
 * Features:
 *  - Anonymous random IDs, no registration
 *  - Random 1:1 pairing from a waiting queue
 *  - "New partner" instant rematch
 *  - Disconnect grace period with session + message restore on reconnect
 *  - Text / image / voice messages (payload size + rate limits)
 *  - Report system with temporary auto-ban for repeat offenders
 *  - Heartbeat-based dead connection cleanup
 *  - HTTP health endpoints for Railway / uptime checks
 *
 * Deploy: Railway (Node.js). Configure ALLOWED_ORIGIN(S) for production.
 */

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const PORT = parseInt(process.env.PORT || '8080', 10);

// Comma-separated list of allowed browser origins. "*" disables the check
// (dev only). In production set this to your Vercel domain.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const TEXT_MAX = 4 * 1024;            // 4 KB per text message
const MEDIA_MAX = 400 * 1024;         // ~400 KB per image/voice payload
const HISTORY_MAX = 200;              // messages kept per session
const GRACE_MS = 45 * 1000;           // keep session alive after disconnect
const RATE_INTERVAL_MS = 2000;        // sliding window for rate limit
const RATE_MAX_MSGS = 5;              // max messages per window
const BAN_REPORTS = 3;                // reports needed to auto-ban
const BAN_MS = 30 * 60 * 1000;        // ban duration (30 min)
const SESSION_TTL_MS = 10 * 60 * 1000; // hard cap for idle sessions
const REMATCH_COOLDOWN_MS = 60 * 1000; // don't re-pair the same two users within 1 min

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const clients = new Map();   // userId -> { ws, sessionId, alive }
const sessions = new Map();  // sessionId -> session
const queue = [];            // userIds waiting for a partner
const reports = new Map();   // userId -> [{ ts, reason }]
const bans = new Map();      // userId -> bannedUntilTs
const recentPartners = new Map(); // userId -> { partnerId, ts } for rematch cooldown

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
  return s;
}

function newGuestId() {
  for (let tries = 0; tries < 20; tries++) {
    const id = 'Guest-' + randomCode(6);
    if (!clients.has(id) && !sessionsHasUser(id)) return id;
  }
  return 'Guest-' + randomCode(8);
}

function sessionsHasUser(userId) {
  for (const s of sessions.values()) {
    if (s.members.includes(userId)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Session management                                                  */
/* ------------------------------------------------------------------ */

function createSession(aId, bId) {
  const sessionId = 'S-' + crypto.randomBytes(8).toString('hex');
  const session = {
    id: sessionId,
    members: [aId, bId],
    history: [],
    createdAt: Date.now(),
    ended: false,
    disconnectedAt: {} // userId -> ts
  };
  sessions.set(sessionId, session);
  return session;
}

function findActiveSession(userId) {
  for (const s of sessions.values()) {
    if (!s.ended && s.members.includes(userId)) return s;
  }
  return null;
}

function partnerOf(session, userId) {
  return session.members.find((m) => m !== userId) || null;
}

function pushHistory(session, msg) {
  session.history.push(msg);
  if (session.history.length > HISTORY_MAX) {
    session.history.splice(0, session.history.length - HISTORY_MAX);
  }
}

function endSession(session, reason) {
  if (session.ended) return;
  session.ended = true;
  for (const memberId of session.members) {
    const c = clients.get(memberId);
    if (c && c.ws && c.ws.readyState === WebSocket.OPEN) {
      send(c.ws, { type: 'session_ended', reason: reason || 'ended' });
    }
  }
  sessions.delete(session.id);
}

/* ------------------------------------------------------------------ */
/* Messaging                                                           */
/* ------------------------------------------------------------------ */

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcastToSession(session, obj, exceptUserId) {
  const raw = JSON.stringify(obj);
  for (const memberId of session.members) {
    if (memberId === exceptUserId) continue;
    const c = clients.get(memberId);
    if (c && c.ws && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(raw);
    }
  }
}

function clientError(ws, code, message) {
  send(ws, { type: 'error', code, message });
}

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

function allowMessage(userId) {
  const c = clients.get(userId);
  if (!c) return false;
  const t = Date.now();
  c.msgTimes = (c.msgTimes || []).filter((x) => t - x < RATE_INTERVAL_MS);
  if (c.msgTimes.length >= RATE_MAX_MSGS) return false;
  c.msgTimes.push(t);
  return true;
}

/* ------------------------------------------------------------------ */
/* Reporting                                                           */
/* ------------------------------------------------------------------ */

const REPORT_REASONS = new Set([
  'spam', 'harassment', 'inappropriate', 'scam', 'impersonation', 'other'
]);

function handleReport(ws, userId, data) {
  const session = findActiveSession(userId);
  if (!session) return clientError(ws, 'no_session', 'You are not in a chat.');

  const accusedId = partnerOf(session, userId);
  if (!accusedId) return;

  const reason = REPORT_REASONS.has(data.reason) ? data.reason : 'other';
  if (!reports.has(accusedId)) reports.set(accusedId, []);
  const list = reports.get(accusedId);
  const now = Date.now();
  list.push({ ts: now, reason, by: userId });
  // keep only last 24h
  reports.set(accusedId, list.filter((r) => now - r.ts < 24 * 3600 * 1000));

  send(ws, { type: 'report_ack' });

  if (reports.get(accusedId).length >= BAN_REPORTS && !bans.has(accusedId)) {
    bans.set(accusedId, now + BAN_MS);
    const accused = clients.get(accusedId);
    if (accused && accused.ws && accused.ws.readyState === WebSocket.OPEN) {
      send(accused.ws, {
        type: 'banned',
        message: 'Multiple user reports received. Access suspended for 30 minutes.',
        until: now + BAN_MS
      });
      accused.ws.close(4003, 'banned');
    }
    // remove any queued / session state for the banned user
    removeFromQueue(accusedId);
    const s = findActiveSession(accusedId);
    if (s) endSession(s, 'partner_reported');
  }
}

function removeFromQueue(userId) {
  const i = queue.indexOf(userId);
  if (i !== -1) queue.splice(i, 1);
}

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

function tryMatch(userId) {
  removeFromQueue(userId); // the initiator must not stay in the queue
  const now = Date.now();

  // bounded scan: if the only candidate is on rematch cooldown, stop instead of looping forever
  let attempts = queue.length;
  while (attempts-- > 0 && queue.length > 0) {
    const candidateId = queue.shift();
    if (candidateId === userId) continue;
    const cand = clients.get(candidateId);
    if (!cand || !cand.ws || cand.ws.readyState !== WebSocket.OPEN) continue;

    // don't instantly re-pair two people who just ended a session together
    const recent = recentPartners.get(userId);
    if (recent && recent.partnerId === candidateId && now - recent.ts < REMATCH_COOLDOWN_MS) {
      queue.push(candidateId); // put back and try the next candidate
      continue;
    }

    const session = createSession(userId, candidateId);
    const a = clients.get(userId);
    const b = clients.get(candidateId);
    if (a) a.sessionId = session.id;
    if (b) b.sessionId = session.id;

    send(a.ws, {
      type: 'matched', sessionId: session.id,
      partner: { userId: candidateId }, history: []
    });
    send(b.ws, {
      type: 'matched', sessionId: session.id,
      partner: { userId: userId }, history: []
    });
    return true;
  }
  // no partner found -> initiator waits in the queue
  queue.push(userId);
  return false;
}

function handleJoin(ws, userId, data) {
  // ban check
  const bannedUntil = bans.get(userId);
  if (bannedUntil && bannedUntil > Date.now()) {
    send(ws, { type: 'banned', message: 'Access suspended due to multiple reports.', until: bannedUntil });
    ws.close(4003, 'banned');
    return;
  }
  if (bannedUntil) bans.delete(userId);

  const existing = findActiveSession(userId);

  if (existing && !existing.ended) {
    // RECONNECT: restore session
    const partnerId = partnerOf(existing, userId);
    delete existing.disconnectedAt[userId];

    const client = clients.get(userId);
    if (client) client.sessionId = existing.id;

    send(ws, {
      type: 'session_restore',
      sessionId: existing.id,
      partner: partnerId ? { userId: partnerId } : null,
      partnerOnline: !!(partnerId && clients.get(partnerId) && clients.get(partnerId).ws &&
        clients.get(partnerId).ws.readyState === WebSocket.OPEN),
      history: existing.history
    });

    if (partnerId) {
      const pc = clients.get(partnerId);
      if (pc && pc.ws && pc.ws.readyState === WebSocket.OPEN) {
        send(pc.ws, { type: 'partner_reconnected' });
      }
    }
    return;
  }

  // No active session -> stay idle until the user presses Start.
  // Pairing only begins when the client explicitly sends { type:'next' }.
  send(ws, { type: 'idle', queueSize: queue.length });
}

function handleNext(ws, userId) {
  const session = findActiveSession(userId);
  if (session) {
    const partnerId = partnerOf(session, userId);
    // remember recent pairings so the same two users aren't instantly re-matched
    if (partnerId) {
      recentPartners.set(userId, { partnerId, ts: Date.now() });
      recentPartners.set(partnerId, { partnerId: userId, ts: Date.now() });
    }
    endSession(session, 'partner_left');
    if (partnerId) {
      const pc = clients.get(partnerId);
      if (pc) {
        pc.sessionId = null;
        // the abandoned partner goes straight back into the queue
        if (pc.ws && pc.ws.readyState === WebSocket.OPEN) {
          removeFromQueue(partnerId);
          queue.push(partnerId);
          send(pc.ws, { type: 'searching', queueSize: queue.length });
          tryMatch(partnerId);
        }
      }
    }
  }
  removeFromQueue(userId);
  const c = clients.get(userId);
  if (c) c.sessionId = null;

  queue.push(userId);
  send(ws, { type: 'searching', queueSize: queue.length });
  tryMatch(userId);
}

function handleChat(ws, userId, data) {
  const session = findActiveSession(userId);
  if (!session || session.ended) return clientError(ws, 'no_session', 'You are not in a chat.');

  if (!allowMessage(userId)) return clientError(ws, 'rate_limited', 'Slow down a little.');

  const kind = data.kind;
  let msg;

  if (kind === 'text') {
    const text = String(data.text || '').slice(0, TEXT_MAX);
    if (!text.trim()) return;
    msg = { from: userId, kind: 'text', text, ts: Date.now() };
  } else if (kind === 'image') {
    const src = String(data.src || '');
    if (!src.startsWith('data:image/') || src.length > MEDIA_MAX) {
      return clientError(ws, 'payload_too_large', 'Image is too large (max ~400 KB after compression).');
    }
    msg = { from: userId, kind: 'image', src, ts: Date.now() };
  } else if (kind === 'voice') {
    const src = String(data.src || '');
    if (!/^data:audio\/(webm|wav|mp4|ogg)/.test(src) || src.length > MEDIA_MAX) {
      return clientError(ws, 'payload_too_large', 'Voice note is too large.');
    }
    const dur = Math.min(300, Math.max(0, Number(data.dur) || 0));
    msg = { from: userId, kind: 'voice', src, dur, ts: Date.now() };
  } else {
    return clientError(ws, 'bad_kind', 'Unsupported message type.');
  }

  pushHistory(session, msg);
  broadcastToSession(session, { type: 'chat', message: msg }, null); // incl. sender for consistency
}

/* ------------------------------------------------------------------ */
/* WebSocket server                                                    */
/* ------------------------------------------------------------------ */

const httpServer = http.createServer((req, res) => {
  const url = req.url || '/';
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      clients: clients.size,
      sessions: sessions.size,
      queue: queue.length,
      uptime: process.uptime()
    }));
    return;
  }
  if (url === '/' ) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('RandomChat backend is running. Connect via WebSocket.');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: 1024 * 1024 // 1 MB hard cap per frame
});

function originAllowed(origin) {
  if (ALLOWED_ORIGINS.includes('*')) return true;
  if (!origin) return true; // non-browser clients
  return ALLOWED_ORIGINS.includes(origin.toLowerCase());
}

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  if (!originAllowed(origin)) {
    ws.close(4001, 'origin not allowed');
    return;
  }
  ws._rmc = { alive: true };
  ws.on('pong', () => { ws._rmc.alive = true; });

  let userId = null;

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (e) {
      return clientError(ws, 'bad_json', 'Invalid JSON.');
    }
    if (!data || typeof data.type !== 'string') return;

    switch (data.type) {
      case 'join': {
        // attach identity: reuse provided userId if still valid & free, else new
        let wanted = String(data.userId || '').slice(0, 32);
        const hasSession = wanted && findActiveSession(wanted);
        if (wanted && !hasSession && clients.has(wanted)) {
          wanted = ''; // id taken by a live connection
        }
        userId = (wanted && /^Guest-[A-Z2-9]{6,8}$/.test(wanted)) ? wanted : newGuestId();

        if (clients.has(userId)) {
          // extremely unlikely: kick old socket
          const old = clients.get(userId);
          if (old.ws) old.ws.close(4000, 'replaced');
        }

        clients.set(userId, { ws, sessionId: null, alive: true, msgTimes: [] });
        send(ws, { type: 'welcome', userId, onlineCount: clients.size });
        handleJoin(ws, userId, data);
        break;
      }
      case 'next': {
        if (!userId) return;
        handleNext(ws, userId);
        break;
      }
      case 'chat': {
        if (!userId) return;
        handleChat(ws, userId, data);
        break;
      }
      case 'report': {
        if (!userId) return;
        handleReport(ws, userId, data);
        break;
      }
      case 'ping': {
        send(ws, { type: 'pong', ts: Date.now() });
        break;
      }
      default:
        clientError(ws, 'unknown_type', 'Unknown message type.');
    }
  });

  ws.on('close', () => {
    if (!userId) return;
    const c = clients.get(userId);
    if (c && c.ws === ws) {
      clients.delete(userId);
      const session = findActiveSession(userId);
      if (session && !session.ended) {
        session.disconnectedAt[userId] = Date.now();
        const partnerId = partnerOf(session, userId);
        if (partnerId) {
          const pc = clients.get(partnerId);
          if (pc && pc.ws && pc.ws.readyState === WebSocket.OPEN) {
            send(pc.ws, { type: 'partner_disconnected', graceSeconds: Math.round(GRACE_MS / 1000) });
          }
        }
      } else {
        removeFromQueue(userId);
      }
    }
  });

  ws.on('error', () => { /* socket errors handled via close */ });
});

/* Heartbeat: kill dead sockets */
setInterval(() => {
  wss.clients.forEach((ws) => {
    const meta = ws._rmc;
    if (meta && meta.alive === false) return ws.terminate();
    if (meta) meta.alive = false;
    try { ws.ping(); } catch (e) { /* noop */ }
  });
}, 30 * 1000);

/* Session garbage collection */
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.ended) { sessions.delete(id); continue; }
    const allGone = s.members.every((m) => {
      const c = clients.get(m);
      return !c || !c.ws || c.ws.readyState !== WebSocket.OPEN;
    });
    const discTimes = Object.values(s.disconnectedAt);
    const graceExpired = allGone && discTimes.length > 0 &&
      discTimes.every((t) => now - t > GRACE_MS);
    const tooOld = now - s.createdAt > SESSION_TTL_MS;
    if (graceExpired || tooOld) {
      s.ended = true;
      sessions.delete(id);
    }
  }
  // prune stale queue entries
  for (let i = queue.length - 1; i >= 0; i--) {
    const c = clients.get(queue[i]);
    if (!c || !c.ws || c.ws.readyState !== WebSocket.OPEN) queue.splice(i, 1);
  }
  // prune expired rematch cooldown records
  for (const [uid, rec] of recentPartners) {
    if (now - rec.ts > REMATCH_COOLDOWN_MS) recentPartners.delete(uid);
  }
}, 10 * 1000);

httpServer.listen(PORT, () => {
  console.log(`[RandomChat] backend listening on :${PORT} (origins: ${ALLOWED_ORIGINS.join(', ')})`);
});
