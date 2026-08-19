/* Runtime configuration.
 *
 * For local development, point this at your local backend:
 *   window.RC_CONFIG = { wsUrl: 'ws://localhost:8080' };
 *
 * For production on Vercel, set the backend's Railway public URL.
 * You can also provide it via a build-time env var injected by Vercel
 * (e.g. NEXT_PUBLIC_*), or simply hardcode the https→wss URL here.
 */
(function () {
  var host = location.hostname;
  var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '';

  // Local preview: talk to the backend running on this machine.
  // Production: Railway public domain like https://random-chat.up.railway.app.
  var RAILWAY_PUBLIC_URL = isLocal
    ? 'http://localhost:8080'
    : ((typeof window !== 'undefined' && window.RAILWAY_PUBLIC_URL) ||
       'https://your-backend.up.railway.app');

  var wsUrl = RAILWAY_PUBLIC_URL
    .replace(/^http:/, 'ws:')
    .replace(/^https:/, 'wss:');

  window.RC_CONFIG = {
    wsUrl: wsUrl,
    reconnectMaxDelay: 15000, // cap for exponential backoff
    mediaMaxBytes: 350 * 1024 // keep under backend's 400KB limit
  };
})();
