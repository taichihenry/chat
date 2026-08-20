/* Runtime configuration.
 *
 * For local development: when the page runs on localhost, it automatically
 * connects to the backend at ws://localhost:8080 (start it with `npm start`).
 *
 * For production on Vercel, set the backend's Render public URL below.
 */
(function () {
  var host = location.hostname;
  var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '';

  // Local preview: talk to the backend running on this machine.
  // Production: Render public URL like https://random-chat-backend.onrender.com
  var BACKEND_PUBLIC_URL = isLocal
    ? 'http://localhost:8080'
    : ((typeof window !== 'undefined' && window.BACKEND_PUBLIC_URL) ||
       'https://your-backend.onrender.com');

  var wsUrl = BACKEND_PUBLIC_URL
    .replace(/^http:/, 'ws:')
    .replace(/^https:/, 'wss:');

  window.RC_CONFIG = {
    wsUrl: wsUrl,
    reconnectMaxDelay: 15000, // cap for exponential backoff
    mediaMaxBytes: 350 * 1024 // keep under backend's 400KB limit
  };
})();
