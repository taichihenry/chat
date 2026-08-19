# RandomChat — Real-Time Random Pairing Chat

A production-ready random chat website with real multi-user real-time pairing.
Anonymous (no registration), auto-reconnect with session restore, text/photo/voice
messages, and a report system.

- **Frontend**: static site → deploy on **Vercel**
- **Backend**: Node.js WebSocket service → deploy on **Railway**

```
random-chat-fullstack/
├── backend/            # WebSocket server (Node.js + ws)
│   ├── server.js       # pairing, sessions, reconnect restore, reports
│   ├── package.json
│   ├── railway.json    # Railway deploy config
│   └── test/smoke.mjs  # end-to-end smoke test (npm test)
└── frontend/           # static frontend
    ├── index.html
    ├── css/style.css
    ├── js/config.js    # ← edit the backend URL here
    ├── js/app.js
    └── vercel.json     # Vercel headers/rewrites
```

## Features

| Feature | How it works |
|---|---|
| Random ID | `Guest-XXXXXX` generated server-side on first join, persisted in `localStorage` |
| Random pairing | FIFO waiting queue; two users matched into a session |
| Instant rematch | "New" button ends session, both sides re-queued; 60s cooldown prevents re-pairing the same two users |
| Auto-reconnect | Exponential backoff (up to 15s); server keeps the session for 45s |
| Session restore | Reconnect with the same ID → server replays up to 200 history messages |
| Text/image/voice | Images auto-compressed client-side (≤400KB); voice recorded via MediaRecorder (≤30s) |
| Reporting | 6 reason categories; 3 reports within 24h → automatic 30-minute ban |
| Rate limiting | Max 5 messages / 2 seconds per user |
| Heartbeat | Server ping/pong every 30s cleans up dead sockets |

## Run locally

```bash
# Terminal 1 — backend (http://localhost:8080)
cd backend
npm install
npm start

# Terminal 2 — frontend (any static server)
cd frontend
npx serve .        # or: python -m http.server 3000
```

Edit `frontend/js/config.js` and set `RAILWAY_PUBLIC_URL` to `http://localhost:8080`
for local testing.

Run the automated end-to-end test (boots the server and drives two clients
through join → match → text/image/voice → disconnect → restore → report → rematch):

```bash
cd backend
npm test
```

## Deploy backend to Railway

1. Push `backend/` to a GitHub repository (or use the Railway CLI / dashboard upload).
2. On [Railway](https://railway.app): **New Project → Deploy from GitHub repo**.
   - Railway auto-detects Node.js (Nixpacks) and runs `npm start` (see `railway.json`).
3. Add a **public domain**: project dashboard → your service → **Settings → Networking → Generate Domain**.
   You'll get something like `https://random-chat.up.railway.app`.
4. Add environment variable:
   - `ALLOWED_ORIGINS` = `https://your-frontend.vercel.app,https://www.your-domain.com`
     (comma-separated list of your frontend origins; use `*` only for testing)
5. Verify: open `https://your-backend.up.railway.app/health` — you should see
   `{"ok":true,"clients":0,"sessions":0,...}`.

## Deploy frontend to Vercel

1. Push `frontend/` to a GitHub repository.
2. On [Vercel](https://vercel.com): **Add New Project → Import** that repo.
   - Framework preset: **Other**; output is the repo root (static files).
3. Before deploying, edit `frontend/js/config.js`:

   ```js
   var RAILWAY_PUBLIC_URL = 'https://your-backend.up.railway.app';
   ```

   (Replace with the domain Railway generated in step 3 above.)
4. Deploy. Your site is live at `https://your-project.vercel.app`.

## Bind your own domain

**Frontend (Vercel)** — this is the domain visitors type:
1. Vercel dashboard → your project → **Settings → Domains**.
2. Add your domain (e.g. `chat.example.com` or `example.com`).
3. Vercel shows the DNS records to add — typically a `CNAME` to
   `cname.vercel-dns.com` (subdomain) or `A` records to Vercel's IPs (apex).
4. Add the records at your domain registrar, wait for propagation.
   Vercel auto-provisions the HTTPS certificate.
5. Update the backend's `ALLOWED_ORIGINS` env var on Railway to include
   `https://example.com,https://www.example.com`, then redeploy.

**Backend**: no custom domain needed — the Railway-generated `*.up.railway.app`
domain works fine with WSS. (You *can* add a custom domain in Railway settings
if you prefer; then update `RAILWAY_PUBLIC_URL` in `config.js` accordingly.)

## Protocol overview (WebSocket JSON)

Client → server:
- `{type:'join', userId?}` — attach identity; server replies `welcome` + (`session_restore` | `idle`)
- `{type:'next'}` — enter the pairing queue / switch partner
- `{type:'chat', kind:'text'|'image'|'voice', ...}` — send a message
- `{type:'report', reason}` — report the current partner
- `{type:'ping'}` — keepalive

Server → client:
- `welcome`, `idle`, `searching`, `matched`, `chat`, `session_restore`,
  `partner_disconnected`, `partner_reconnected`, `session_ended`,
  `report_ack`, `banned`, `error`, `pong`

## Operational notes

- Sessions and history live **in server memory** (no database). A Railway
  redeploy clears all active sessions — acceptable for this app's anonymous
  chat model. If you need persistence across restarts, add Redis
  (Railway has a one-click Redis template).
- Scale: one Railway instance handles thousands of concurrent WebSocket
  connections. Horizontal scaling requires sticky sessions + shared state
  (Redis pub/sub) and is out of scope for this single-instance design.
- Safety limits: 4KB text, ~400KB media, 5 msg/2s rate limit, 30s max voice
  note, 3 reports → 30-min ban.
