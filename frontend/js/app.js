'use strict';
/* ================================================================
   RandomChat — frontend app
   Connects to the backend WebSocket service, handles random
   pairing, messaging (text/image/voice), auto-reconnect with
   session restore, and reporting.
   ================================================================ */

/* ---------- helpers ---------- */
const $ = (s) => document.querySelector(s);
const fmtTime = (ts) => { const d = new Date(ts); return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0'); };
const fmtDur = (s) => Math.floor(s/60) + ':' + String(s%60).padStart(2,'0');
const escapeHtml = (t) => t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function toast(msg, ms = 2800){
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), ms);
}

/* ---------- identity ---------- */
const LS_ID = 'rc_user_id';
function getSavedId(){ return localStorage.getItem(LS_ID) || ''; }
function saveId(id){ localStorage.setItem(LS_ID, id); }

/* ---------- state ---------- */
const state = {
  ws: null,
  myId: getSavedId(),
  connected: false,
  reconnecting: false,
  reconnectAttempts: 0,
  reconnectTimer: null,
  screen: 'landing',
  partnerId: null,
  partnerOnline: true,
  searching: false,
  searchStart: 0,
  searchTimer: null,
  rec: { active:false, timer:null, secs:0 }
};

/* ---------- screens ---------- */
function showScreen(name){
  state.screen = name;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('#' + name).classList.add('active');
}

/* ---------- connection ---------- */
function connect(){
  if(state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;

  setConnState('connecting');
  const ws = new WebSocket(RC_CONFIG.wsUrl);
  state.ws = ws;

  ws.onopen = () => {
    state.connected = true;
    state.reconnecting = false;
    state.reconnectAttempts = 0;
    clearTimeout(state.reconnectTimer);
    setConnState('online');
    $('#offlineOverlay').classList.remove('on');
    $('#reconnectBanner').classList.remove('on');
    // join / rejoin with our persistent id -> server restores session if any
    ws.send(JSON.stringify({ type: 'join', userId: state.myId || undefined }));
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch(e){ return; }
    handleServerMsg(msg);
  };

  ws.onclose = (ev) => {
    state.connected = false;
    state.ws = null;
    setConnState('offline');
    if(ev.code === 4003){ return; } // banned — no reconnect
    scheduleReconnect();
  };

  ws.onerror = () => { /* close event follows */ };
}

function scheduleReconnect(){
  if(state.reconnectTimer) return;
  state.reconnecting = true;
  $('#offlineOverlay').classList.add('on');
  $('#reconnectBanner').classList.add('on');
  $('#bannerText').textContent = 'Connection lost — reconnecting…';

  const attempt = state.reconnectAttempts++;
  const delay = Math.min(RC_CONFIG.reconnectMaxDelay, 1000 * Math.pow(2, attempt)) * (0.7 + Math.random()*0.6);
  let remain = Math.ceil(delay/1000);
  $('#ovCount').textContent = 'Reconnecting in ' + remain + 's…';
  const cd = setInterval(() => {
    remain--;
    if(remain > 0) $('#ovCount').textContent = 'Reconnecting in ' + remain + 's…';
    else clearInterval(cd);
  }, 1000);

  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    clearInterval(cd);
    connect();
  }, delay);
}

function setConnState(mode){
  const el = $('#connState');
  if(mode === 'online'){
    el.innerHTML = '<span class="dot"></span> Connected to server';
    $('#startBtn').disabled = false;
  }
  else if(mode === 'connecting'){ el.innerHTML = '<span class="dot dot-warn"></span> Connecting to server…'; }
  else {
    el.innerHTML = '<span class="dot dot-bad"></span> Offline — reconnecting…';
    $('#startBtn').disabled = true;
  }
}

/* ---------- server message handling ---------- */
function handleServerMsg(msg){
  switch(msg.type){
    case 'welcome':
      state.myId = msg.userId;
      saveId(msg.userId);
      $('#myIdValue').textContent = msg.userId;
      break;

    case 'searching':
      enterSearching();
      break;

    case 'idle':
      // no active session and not searching — stay on landing
      if(state.screen === 'searching'){ showScreen('landing'); }
      break;

    case 'matched':
      enterChat(msg.partner.userId, msg.history || []);
      toast('Matched! Say hi 👋');
      break;

    case 'session_restore':
      if(msg.partner){
        enterChat(msg.partner.userId, msg.history || [], true);
        state.partnerOnline = !!msg.partnerOnline;
        updatePartnerStatus();
        toast('Reconnected — chat restored');
      } else {
        // partner already gone -> back to queue
        showScreen('landing');
      }
      break;

    case 'chat':
      renderIncoming(msg.message);
      break;

    case 'partner_disconnected':
      state.partnerOnline = false;
      updatePartnerStatus();
      addSysLine(`⚠️ Partner's connection dropped. Waiting up to ${msg.graceSeconds}s for them to return…`);
      break;

    case 'partner_reconnected':
      state.partnerOnline = true;
      updatePartnerStatus();
      addSysLine('📶 Partner reconnected.');
      break;

    case 'session_ended':
      if(state.screen === 'chat'){
        addSysLine('— Chat ended —');
      }
      if(msg.reason === 'partner_left'){
        toast('Partner left — finding someone new…');
      }
      break;

    case 'report_ack':
      $('#reportForm').style.display = 'none';
      $('#reportDone').style.display = '';
      break;

    case 'banned':
      showScreen('banned');
      $('#bannedMsg').textContent = msg.message || 'Access suspended.';
      $('#bannedUntil').textContent = msg.until ? 'Until ' + new Date(msg.until).toLocaleString() : '';
      break;

    case 'error':
      toast(msg.message || 'Server error');
      break;

    case 'pong':
      break;
  }
}

/* ---------- searching screen ---------- */
function enterSearching(){
  state.searching = true;
  state.partnerId = null;
  showScreen('searching');
  if(!state.searchStart) state.searchStart = Date.now();
  clearInterval(state.searchTimer);
  state.searchTimer = setInterval(() => {
    $('#searchElapsed').textContent = ((Date.now() - state.searchStart)/1000).toFixed(1);
  }, 100);
}

function leaveSearching(){
  state.searching = false;
  state.searchStart = 0;
  clearInterval(state.searchTimer);
}

$('#cancelSearchBtn').addEventListener('click', () => {
  leaveSearching();
  showScreen('landing');
  toast('Search cancelled');
});

/* ---------- chat session ---------- */
const PARTNER_EMOJIS = ['🙂','😎','🦊','🐼','🐸','🦄','🐙','🐯','🌸','🍀','🌙','⚡','🎧','🏄','🎨','🚀'];
const PARTNER_COLORS = ['#8b5cf6,#6366f1','#22d3ee,#3b82f6','#f472b6,#fb7185','#34d399,#10b981','#fbbf24,#f59e0b','#a78bfa,#ec4899'];

function partnerEmoji(id){
  let h = 0;
  for(let i=0;i<id.length;i++) h = (h*31 + id.charCodeAt(i)) >>> 0;
  return PARTNER_EMOJIS[h % PARTNER_EMOJIS.length];
}
function partnerColor(id){
  let h = 0;
  for(let i=0;i<id.length;i++) h = (h*17 + id.charCodeAt(i)) >>> 0;
  return PARTNER_COLORS[h % PARTNER_COLORS.length];
}

function enterChat(partnerId, history, restored){
  leaveSearching();
  state.partnerId = partnerId;
  state.partnerOnline = true;
  showScreen('chat');

  const av = $('#partnerAvatar');
  av.textContent = partnerEmoji(partnerId);
  av.style.background = `linear-gradient(135deg,${partnerColor(partnerId)})`;
  $('#partnerName').textContent = partnerId;
  updatePartnerStatus();

  const area = $('#msgArea');
  area.innerHTML = '';
  if(restored) addSysLine('📶 Connection restored — your chat history is below.');
  else addSysLine('🔒 You are now chatting with a stranger. Say hi! Be kind.');

  for(const m of history){
    renderMessage(m, false);
  }
  scrollBottom();
}

function updatePartnerStatus(){
  const el = $('#partnerStatus');
  const dot = $('#partnerDot');
  if(state.partnerOnline){
    el.textContent = 'connected';
    dot.style.background = 'var(--ok)';
    dot.style.boxShadow = '0 0 8px var(--ok)';
  } else {
    el.textContent = 'reconnecting…';
    dot.style.background = 'var(--warn)';
    dot.style.boxShadow = '0 0 8px var(--warn)';
  }
}

function addSysLine(text){
  const div = document.createElement('div');
  div.className = 'sys-line';
  div.textContent = text;
  $('#msgArea').appendChild(div);
  scrollBottom();
}

function scrollBottom(){
  const a = $('#msgArea');
  a.scrollTop = a.scrollHeight;
}

/* ---------- message rendering ---------- */
function renderIncoming(m){
  renderMessage(m, true);
}

function renderMessage(m, animate){
  const mine = m.from === state.myId;
  const row = document.createElement('div');
  row.className = 'msg-row ' + (mine ? 'mine' : 'theirs');
  if(!mine && state.partnerId){
    const av = document.createElement('div');
    av.className = 'mini-av';
    av.textContent = partnerEmoji(state.partnerId);
    av.style.background = `linear-gradient(135deg,${partnerColor(state.partnerId)})`;
    row.appendChild(av);
  }
  const wrap = document.createElement('div');
  wrap.style.minWidth = '0';
  row.appendChild(wrap);
  $('#msgArea').appendChild(row);

  if(m.kind === 'text'){
    wrap.innerHTML = `<div class="bubble">${escapeHtml(m.text)}<div class="msg-time">${fmtTime(m.ts)}</div></div>`;
  } else if(m.kind === 'image'){
    const bubble = document.createElement('div');
    bubble.className = 'bubble img-bubble';
    const img = document.createElement('img');
    img.src = m.src;
    img.alt = 'Shared photo';
    img.addEventListener('click', () => openLightbox(m.src));
    bubble.appendChild(img);
    bubble.insertAdjacentHTML('beforeend', `<div class="msg-time">${fmtTime(m.ts)}</div>`);
    wrap.appendChild(bubble);
  } else if(m.kind === 'voice'){
    wrap.innerHTML =
      `<div class="bubble voice-bubble">
         <button class="voice-play" aria-label="Play voice note">▶</button>
         <div class="voice-bars">${Array.from({length:16}, () => `<i style="height:${20+Math.floor(Math.random()*70)}%"></i>`).join('')}</div>
         <span class="voice-dur">${fmtDur(Math.max(1, Math.round(m.dur||1)))}</span>
       </div>
       <div class="msg-time">${fmtTime(m.ts)}</div>`;
    const btn = wrap.querySelector('.voice-play');
    let audio = null;
    btn.addEventListener('click', () => {
      if(!audio){ audio = new Audio(m.src); audio.addEventListener('ended', () => btn.textContent = '▶'); }
      if(audio.paused){ audio.currentTime = 0; audio.play().catch(()=>toast('Playback blocked by browser')); btn.textContent = '⏸'; }
      else { audio.pause(); btn.textContent = '▶'; }
    });
  }
  if(animate) scrollBottom();
}

/* ---------- send actions ---------- */
function wsSend(obj){
  if(state.ws && state.ws.readyState === WebSocket.OPEN){
    state.ws.send(JSON.stringify(obj));
    return true;
  }
  toast('Not connected — reconnecting…');
  return false;
}

function sendText(){
  const inp = $('#msgInput');
  const text = inp.value.trim();
  if(!text) return;
  if(state.reconnecting){ toast('Reconnecting… please wait'); return; }
  inp.value = '';
  wsSend({ type:'chat', kind:'text', text });
}

$('#sendBtn').addEventListener('click', sendText);
$('#msgInput').addEventListener('keydown', (e) => { if(e.key === 'Enter') sendText(); });

/* image send: compress to fit backend limit */
$('#imgBtn').addEventListener('click', () => {
  if(state.reconnecting){ toast('Reconnecting… please wait'); return; }
  $('#imgFile').click();
});

$('#imgFile').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if(!file) return;
  if(!file.type.startsWith('image/')){ toast('Please choose an image file'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const src = compressImage(img);
      wsSend({ type:'chat', kind:'image', src });
    };
    img.onerror = () => toast('Could not read that image');
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

function compressImage(img){
  const MAX_DIM = 1000;
  let quality = 0.82;
  let c = document.createElement('canvas');
  const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  let out = c.toDataURL('image/jpeg', quality);
  // step quality down until under the limit
  while(out.length > RC_CONFIG.mediaMaxBytes && quality > 0.35){
    quality -= 0.1;
    out = c.toDataURL('image/jpeg', quality);
  }
  // still too big? downscale further
  let dim = 0.8;
  while(out.length > RC_CONFIG.mediaMaxBytes && dim > 0.25){
    const c2 = document.createElement('canvas');
    c2.width = Math.round(c.width * dim);
    c2.height = Math.round(c.height * dim);
    c2.getContext('2d').drawImage(c, 0, 0, c2.width, c2.height);
    out = c2.toDataURL('image/jpeg', quality);
    dim -= 0.15;
  }
  return out;
}

/* voice recording */
let mediaRecorder = null, recChunks = [], recStream = null;
const voiceBtn = $('#voiceBtn');

voiceBtn.addEventListener('click', async () => {
  if(state.reconnecting){ toast('Reconnecting… please wait'); return; }
  if(state.rec.active){ stopRecording(); return; }
  await startRecording();
});

async function startRecording(){
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    toast('Voice recording is not supported in this browser');
    return;
  }
  try{
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }catch(err){
    toast('Microphone permission denied');
    return;
  }
  state.rec.secs = 0;
  $('#recSecs').textContent = '0:00';
  mediaRecorder = new MediaRecorder(recStream);
  recChunks = [];
  mediaRecorder.ondataavailable = (e) => { if(e.data.size) recChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    const blob = new Blob(recChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    recStream.getTracks().forEach(t => t.stop());
    if(blob.size > RC_CONFIG.mediaMaxBytes){
      toast('Voice note too long (max ~30s)');
      return;
    }
    const rd = new FileReader();
    rd.onload = () => wsSend({ type:'chat', kind:'voice', src: rd.result, dur: state.rec.secs });
    rd.readAsDataURL(blob);
  };
  mediaRecorder.start();
  state.rec.active = true;
  voiceBtn.classList.add('recording');
  $('#recTimer').classList.add('on');
  $('#msgInput').style.display = 'none';
  state.rec.timer = setInterval(() => {
    state.rec.secs++;
    $('#recSecs').textContent = fmtDur(state.rec.secs);
    if(state.rec.secs >= 30) stopRecording();
  }, 1000);
}

function stopRecording(){
  if(!state.rec.active) return;
  state.rec.active = false;
  clearInterval(state.rec.timer);
  voiceBtn.classList.remove('recording');
  $('#recTimer').classList.remove('on');
  $('#msgInput').style.display = '';
  if(mediaRecorder && mediaRecorder.state !== 'inactive'){
    mediaRecorder.stop();
  }
}

/* ---------- lightbox ---------- */
function openLightbox(src){
  $('#lightboxImg').src = src;
  $('#lightbox').classList.add('on');
}
$('#lightbox').addEventListener('click', () => $('#lightbox').classList.remove('on'));

/* ---------- report ---------- */
const REASONS = [
  ['spam','Spam or advertising'],
  ['harassment','Harassment or abuse'],
  ['inappropriate','Inappropriate content'],
  ['scam','Scam or fraud attempt'],
  ['impersonation','Pretending to be someone else'],
  ['other','Other']
];
let selReason = null;
const reasonList = $('#reasonList');
REASONS.forEach(([val, label]) => {
  const lab = document.createElement('label');
  lab.className = 'reason';
  lab.innerHTML = `<input type="radio" name="reason" value="${val}"><span>${label}</span>`;
  lab.querySelector('input').addEventListener('change', () => {
    selReason = val;
    reasonList.querySelectorAll('.reason').forEach(x => x.classList.remove('sel'));
    lab.classList.add('sel');
  });
  reasonList.appendChild(lab);
});

$('#reportBtn').addEventListener('click', () => {
  if(!state.partnerId){ toast('No active chat to report'); return; }
  selReason = null;
  reasonList.querySelectorAll('.reason').forEach(x => x.classList.remove('sel'));
  reasonList.querySelectorAll('input').forEach(x => x.checked = false);
  $('#reportForm').style.display = '';
  $('#reportDone').style.display = 'none';
  $('#reportModal').classList.add('on');
});
$('#reportCancelBtn').addEventListener('click', () => $('#reportModal').classList.remove('on'));
$('#reportSubmitBtn').addEventListener('click', () => {
  if(!selReason){ toast('Please choose a reason first'); return; }
  wsSend({ type:'report', reason: selReason });
});
$('#reportStayBtn').addEventListener('click', () => {
  $('#reportModal').classList.remove('on');
  toast('Report submitted. You can keep chatting.');
});
$('#reportLeaveBtn').addEventListener('click', () => {
  $('#reportModal').classList.remove('on');
  newChat();
});
$('#reportModal').addEventListener('click', (e) => { if(e.target === $('#reportModal')) $('#reportModal').classList.remove('on'); });

/* ---------- navigation ---------- */
function newChat(){
  wsSend({ type:'next' });
  enterSearching();
}

$('#newChatBtn').addEventListener('click', newChat);
$('#startBtn').addEventListener('click', newChat);

/* online/offline browser events */
window.addEventListener('offline', () => { if(state.connected) { state.connected = false; scheduleReconnect(); } });
window.addEventListener('online', () => { if(!state.connected) connect(); });

/* keepalive ping every 20s */
setInterval(() => { if(state.connected) wsSend({ type:'ping' }); }, 20000);

/* online counter (from welcome payload, refreshed opportunistically) */
const origHandle = handleServerMsg;
handleServerMsg = function(msg){
  if(msg.type === 'welcome' && msg.onlineCount){
    $('#onlineCount').textContent = msg.onlineCount.toLocaleString('en-US');
  }
  origHandle(msg);
};

/* ---------- boot ---------- */
$('#myIdValue').textContent = state.myId || '…';
showScreen('landing');
connect();
