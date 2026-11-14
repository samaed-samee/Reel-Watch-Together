/* =========================================================
   REEL — watch together
   ========================================================= */
const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

const ALPHA    = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 12;
const PREFIX   = 'reel12v1-';

const state = {
  role: null,            // 'host' | 'guest'
  code: '',
  username: '',
  partnerName: '',
  partnerOnline: false,
  joinAnnounced: false,
  peer: null,
  conn: null,
  connected: false,
  mediaLoaded: false,
  localFile: null,
  mediaUrl: null,
  blobUrl: null,
  mediaName: '',
  isYT: false,
  ytId: null,
  suppressUntil: 0,
  recv: null,
  sending: false,
  messages: [],
  typingTimer: null,
  remoteTypingTimer: null,
  lastTypingSent: 0,
  clientId: '',
  partnerClientId: '',
  partnerPeerId: '',      // signalling id of the other browser (used for voice)
  secure: false,          // E2E handshake verified
  crypto: null,           // per-connection AES-GCM keys
  sas: '',                // 6-digit safety code for out-of-band check
  securityFailure: false,
  intentionalLeave: false,
  reconnectAttempts: 0,
  reconnectTimer: null,
  replyTo: null,
  playlist: [],           // [{ url, name }] — synced over the E2E channel
  plIndex: -1,            // which playlist item is playing right now
  localQueue: [],         // extra File objects picked here — play after this one
  pingWait: null,         // pending liveness probe after coming back to the app
  aspect: { mode: 'fit', frame: '16-9' },   // how a direct video fills the player (local)
};

/* ---------- helpers ---------- */
const uid = () => Math.random().toString(36).slice(2, 10);
const haptic = (ms = 10) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} };

function genCode() {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += ALPHA[Math.floor(Math.random() * ALPHA.length)];
  return s;
}
const formatCode = c => c.replace(/(.{4})(?=.)/g, '$1-');
const cleanCode  = c => (c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);

function fmtClock(ts) {
  const d = new Date(ts);
  let h = d.getHours(), m = d.getMinutes();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + String(m).padStart(2, '0') + ' ' + ap;
}
function fmtDur(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
           : `${m}:${String(s).padStart(2,'0')}`;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ---------- session persistence ---------- */
const SESSION_KEY   = 'reel-session';
const CLIENT_KEY    = 'reel-client-id';
const MAX_RECONNECT = 40;   // ~5 minutes of retries; reset whenever the app returns

function saveSession() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      role: state.role, code: state.code, username: state.username
    }));
  } catch (e) {}
}
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
}
function getClientId() {
  try {
    let id = localStorage.getItem(CLIENT_KEY);
    if (!id) { id = uid() + uid(); localStorage.setItem(CLIENT_KEY, id); }
    return id;
  } catch (e) { return uid() + uid(); }
}
state.clientId = getClientId();

/* ---------- floating emoji ---------- */
const floatLayer = document.createElement('div');
floatLayer.className = 'float-layer';
document.body.appendChild(floatLayer);

function spawnFloatingEmoji(emoji, opts = {}) {
  const count = opts.count || (opts.both ? 2 : 1);
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className = 'float-emoji';
    el.textContent = emoji;
    const startX = 8 + Math.random() * 84;                 // spread across screen
    const dx = (Math.random() * 2 - 1) * (30 + Math.random() * 70);
    el.style.left = startX.toFixed(1) + 'vw';
    el.style.bottom = (4 + Math.random() * 16).toFixed(1) + 'vh';
    el.style.fontSize = (26 + Math.random() * 24).toFixed(0) + 'px';
    el.style.setProperty('--dx', dx.toFixed(0) + 'px');
    el.style.setProperty('--rot', (Math.random() * 90 - 45).toFixed(0) + 'deg');
    el.style.animationDelay = (i * 85 + Math.random() * 70) + 'ms';
    floatLayer.appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }
}

const EMOJI_ONLY_RE = /^[\p{Extended_Pictographic}\u200d\uFE0F\u{1F3FB}-\u{1F3FF}\s]+$/u;
function isEmojiOnly(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  return t.length > 0 && t.length <= 24 && EMOJI_ONLY_RE.test(t);
}
function floatEmojiText(text) {
  const chars = Array.from(text).filter(c => /\p{Extended_Pictographic}/u.test(c));
  const list = (chars.length ? chars : [text]).slice(0, 5);
  list.forEach((c, i) => setTimeout(() => spawnFloatingEmoji(c, { both: true }), i * 110));
}

/* ---------- DOM ---------- */
const viewHome = $('#view-home');
const viewRoom = $('#view-room');
const video    = $('#video');
const videoWrap= $('#video-wrap');
const chat     = $('#chat');
const msgInput = $('#msg-input');
const sendBtn  = $('#btn-send');
const emojiPanel = $('#emoji-panel');
const typingInd  = $('#typing-ind');
const scrub      = $('#scrub');
const scrubFill  = $('#scrub-fill');
const scrubKnob  = $('#scrub-knob');
const timeCur    = $('#time-cur');
const timeDur    = $('#time-dur');
const ytStage    = $('#yt-stage');

/* ---------- YouTube ---------- */
let ytPlayer = null;
let ytReady  = false;
let ytApiPromise = null;

function loadYTAPI() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise(resolve => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (typeof prev === 'function') prev(); resolve(); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    document.head.appendChild(s);
    setTimeout(resolve, 8000);
  });
  return ytApiPromise;
}

function parseYouTube(url) {
  if (!url) return null;
  const m = String(url).match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

const YT_REF_POLICY = 'strict-origin-when-cross-origin';
let ytRetried = false;

function ytEmbedSrc(id, host) {
  const q = new URLSearchParams({
    enablejsapi: '1', playsinline: '1', rel: '0', modestbranding: '1',
    controls: '0', disablekb: '1', fs: '0', iv_load_policy: '3'
  });
  if (/^https?:/i.test(location.protocol)) q.set('origin', location.origin);
  return host + '/embed/' + encodeURIComponent(id) + '?' + q.toString();
}

/* Build the <iframe> ourselves so the referrer policy is applied *before* the
   player makes its first request. If the request reaches YouTube without a
   Referer it answers "player configuration error 153". */
function mountYTPlayer(id, name, useNoCookie) {
  const host = useNoCookie ? 'https://www.youtube-nocookie.com' : 'https://www.youtube.com';
  ytStage.innerHTML = '';

  const iframe = document.createElement('iframe');
  iframe.src = ytEmbedSrc(id, host);
  iframe.setAttribute('title', name || 'YouTube video');
  iframe.setAttribute('referrerpolicy', YT_REF_POLICY);
  iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
  iframe.setAttribute('allowfullscreen', '');
  iframe.setAttribute('frameborder', '0');
  ytStage.appendChild(iframe);
  ytReady = false;

  const player = new YT.Player(iframe, {
    events: {
      onReady: () => {
        if (ytPlayer !== player) return;
        ytReady = true;
        timeDur.textContent = fmtDur(player.getDuration());
        paintScrub();
        updatePlayIcon();
        player.playVideo();
        setTimeout(() => {
          if (ytReady && ytPlayer === player && player.getPlayerState() !== 1) {
            $('#tap-play').classList.add('show');
          }
        }, 900);
      },
      onStateChange: (e) => { if (ytPlayer === player) onYTState(e); },
      onError: (e) => {
        if (ytPlayer !== player) return;
        const code = e && e.data;
        // the privacy-enhanced host is stricter about referrers — try the main one
        if (code === 153 && useNoCookie && !ytRetried) {
          ytRetried = true;
          console.warn('YouTube 153 on youtube-nocookie.com — retrying on www.youtube.com');
          mountYTPlayer(id, name, false);
          return;
        }
        if (code === 153) {
          toast('YouTube 153: open this page over http://localhost');
          console.warn('YouTube error 153: no HTTP Referer reached YouTube. Do not open index.html via file:// — run start.cmd (or "python -m http.server 8000") and use http://localhost:8000.');
        } else if (code === 101 || code === 150) {
          toast("This video's owner doesn't allow embedding");
        } else if (code === 100) {
          toast('Video not found or private');
        } else {
          toast('YouTube could not play this video (error ' + code + ')');
        }
      }
    }
  });
  ytPlayer = player;
}

function destroyYouTube() {
  state.isYT = false;
  state.ytId = null;
  ytReady = false;
  ytRetried = false;
  if (ytPlayer) {
    try { ytPlayer.destroy(); } catch (e) {}
    ytPlayer = null;
  }
  ytStage.innerHTML = '';
  videoWrap.classList.remove('is-yt');
  destroyHls();
  setRate(1, false);
}

async function loadYouTube(id, name) {
  setRate(1, false);
  state.isYT = true;
  state.ytId = id;
  state.mediaLoaded = true;
  state.mediaName = name || 'YouTube video';
  videoWrap.classList.add('has-media', 'is-yt');
  $('#tap-play').classList.remove('show');
  hideTransfer();
  try { video.pause(); } catch (e) {}
  video.removeAttribute('src');
  try { video.load(); } catch (e) {}
  resetScrub();
  addSystem('🎬 ' + state.mediaName);

  // YouTube requires an HTTP Referer, so a file:// page always fails with
  // error 153. Point the user at start.cmd instead of just failing silently.
  if (location.protocol === 'file:') {
    toast('YouTube needs http:// — open start.cmd, not the file directly');
  }

  await loadYTAPI();
  if (!window.YT || !window.YT.Player) { toast('Could not load YouTube player'); return; }

  ytRetried = false;
  mountYTPlayer(id, name, true);
}

function onYTState(e) {
  if (!ytReady) return;
  updatePlayIcon();
  showControls();
  if (e.data === 1) $('#tap-play').classList.remove('show');
  if (Date.now() <= state.suppressUntil) return;
  const t = ytPlayer.getCurrentTime();
  if (e.data === 1) send({ t: 'cmd', a: 'play', time: t });
  else if (e.data === 2) send({ t: 'cmd', a: 'pause', time: t });
}

/* ---------- view transitions ---------- */
function showHome() {
  viewRoom.classList.add('hidden');
  viewRoom.classList.remove('back');
  viewHome.classList.remove('hidden', 'back');
}
function showRoomView() {
  viewHome.classList.add('hidden', 'back');
  viewRoom.classList.remove('hidden', 'back');
  viewRoom.classList.remove('enter');
  void viewRoom.offsetWidth;
  viewRoom.classList.add('enter');
}

/* =========================================================
   END-TO-END ENCRYPTION
   ECDH P-256 → HKDF-SHA256 → AES-GCM-256, plus an HMAC-SHA256
   key-confirmation step and a safety code both people can compare.
   PeerJS (the signalling relay) only ever sees the room id and the
   encrypted envelopes: chat, sync commands and the movie stream are
   decrypted on the two devices and nowhere else.
   ========================================================= */
const MAX_TEXT       = 2000;
const MAX_NAME       = 20;
const MAX_URL        = 2048;
const MAX_MEDIA_NAME = 120;
const MAX_FILE_BYTES = 1536 * 1024 * 1024;   // 1.5 GiB
const MAX_PLAYLIST   = 50;
const MAX_PL_NAME    = 120;
const HANDSHAKE_TIMEOUT = 15000;

const subtleCrypto = (window.crypto && window.crypto.subtle) || null;
const textEnc = new TextEncoder();
const textDec = new TextDecoder();
const DATA_AAD  = textEnc.encode('reel-e2e-v1/data');
const CHUNK_AAD = textEnc.encode('reel-e2e-v1/chunk');
const CHUNK_MAGIC = 0xE1;

function b64encode(buf) {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
function b64decode(str) {
  const bin = atob(String(str));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
function concatBytes(...parts) {
  let len = 0;
  for (let i = 0; i < parts.length; i++) len += parts[i].length;
  const out = new Uint8Array(len);
  let off = 0;
  for (let i = 0; i < parts.length; i++) { out.set(parts[i], off); off += parts[i].length; }
  return out;
}
async function sha256(...parts) {
  return new Uint8Array(await subtleCrypto.digest('SHA-256', concatBytes(...parts)));
}
async function hkdfBytes(ikm, salt, info, len) {
  const key = await subtleCrypto.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtleCrypto.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: textEnc.encode(info) },
    key, len * 8
  );
  return new Uint8Array(bits);
}
function importAesKey(raw) {
  return subtleCrypto.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
function timingSafeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
function sasFromTranscript(t) {
  let n = 0;
  for (let i = 0; i < 6; i++) n = (n * 256 + t[i]) % 1000000;
  return String(n).padStart(6, '0');
}
function isSafeId(v) {
  return typeof v === 'string' && /^[a-z0-9]{1,32}$/i.test(v);
}
function safeMediaUrl(u) {
  if (typeof u !== 'string' || !u || u.length > MAX_URL) return null;
  if (!/^https?:\/\//i.test(u)) return null;
  try {
    const p = new URL(u);
    return (p.protocol === 'http:' || p.protocol === 'https:') ? p.href : null;
  } catch (e) { return null; }
}
function cleanReply(r) {
  if (!r || typeof r !== 'object') return null;
  const text = typeof r.text === 'string' ? r.text.slice(0, MAX_TEXT) : '';
  if (!text) return null;
  return {
    id: isSafeId(r.id) ? r.id : '',
    text,
    name: typeof r.name === 'string' ? r.name.slice(0, MAX_NAME) : ''
  };
}

/* ---------- token buckets (flood protection) ---------- */
function makeBucket(capacity, perSecond) {
  return { cap: capacity, tokens: capacity, rate: perSecond, last: Date.now() };
}
function takeToken(b, cost) {
  const now = Date.now();
  b.tokens = Math.min(b.cap, b.tokens + (now - b.last) / 1000 * b.rate);
  b.last = now;
  const c = cost || 1;
  if (b.tokens < c) return false;
  b.tokens -= c;
  return true;
}
const rxBucket = makeBucket(40, 20);    // incoming control frames
const rxVoice  = makeBucket(4, 0.2);    // incoming voice invitations
const rxAnim   = makeBucket(6, 0.5);    // incoming reactions / emoji bursts
const rxFile   = makeBucket(3, 0.05);   // incoming file offers
const rxPl     = makeBucket(16, 2);     // incoming playlist frames
const rxPing   = makeBucket(6, 1);      // incoming liveness probes
const txChat   = makeBucket(6, 1.5);    // outgoing chat messages
const txAnim   = makeBucket(4, 0.4);    // outgoing emoji bursts

/* ---------- encrypted transport ---------- */
let txChain = Promise.resolve();
let voiceTxChain = Promise.resolve();
let rxChain = Promise.resolve();

function resetCrypto() {
  state.secure = false;
  state.crypto = null;
  state.sas = '';
  rxChain = Promise.resolve();
  txChain = Promise.resolve();
  voiceTxChain = Promise.resolve();
}

function sendRaw(obj) {
  const c = state.conn;
  if (!c || !c.open) return false;
  try { c.send(obj); return true; } catch (e) { return false; }
}

async function encryptJSON(obj) {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtleCrypto.encrypt(
    { name: 'AES-GCM', iv, additionalData: DATA_AAD },
    state.crypto.send, textEnc.encode(JSON.stringify(obj))
  ));
  return { t: 'enc', d: b64encode(concatBytes(iv, ct)) };
}

async function encryptChunk(buf) {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtleCrypto.encrypt(
    { name: 'AES-GCM', iv, additionalData: CHUNK_AAD }, state.crypto.sendChunk, buf
  ));
  const out = new Uint8Array(1 + 12 + ct.length);
  out[0] = CHUNK_MAGIC;
  out.set(iv, 1);
  out.set(ct, 13);
  return out.buffer;
}

/* ---------- handshake ---------- */
async function startHandshake(conn) {
  if (!subtleCrypto) { failHandshake(conn, 'Encryption needs https:// or localhost'); return; }
  try {
    const kp = await subtleCrypto.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    if (state.conn !== conn) return;
    const pub = new Uint8Array(await subtleCrypto.exportKey('raw', kp.publicKey));
    conn._hs = {
      kp, pub, peerPub: null, peerRole: null, transcript: null,
      confKey: null, keys: null, verified: false, readyP: null, readyRes: null
    };
    conn._hsAt = Date.now();

    // The partner's frames may have arrived while we were generating keys.
    const pre = conn._pre || [];
    conn._pre = [];
    pre.forEach(m => dispatchHandshake(conn, m));

    sendRaw({ t: 'key', v: 1, role: state.role, pub: b64encode(pub) });
  } catch (e) {
    failHandshake(conn, 'Could not start encryption');
  }
}

async function handshakeKey(conn, msg) {
  const hs = conn._hs;
  if (!hs || hs.peerPub || hs.verified) return;
  if (msg.v !== 1) return failHandshake(conn, 'Unsupported encryption version');
  const wantRole = state.role === 'host' ? 'guest' : 'host';
  if (msg.role !== wantRole) return failHandshake(conn, 'Unexpected peer role');
  if (typeof msg.pub !== 'string' || msg.pub.length > 200) return failHandshake(conn, 'Bad public key');

  let raw;
  try { raw = b64decode(msg.pub); } catch (e) { return failHandshake(conn, 'Bad public key'); }
  if (raw.length !== 65 || raw[0] !== 0x04) return failHandshake(conn, 'Bad public key');

  try {
    const peerKey = await subtleCrypto.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const secret = new Uint8Array(await subtleCrypto.deriveBits(
      { name: 'ECDH', public: peerKey }, hs.kp.privateKey, 256
    ));

    const iAmHost = state.role === 'host';
    const hostPub  = iAmHost ? hs.pub : raw;
    const guestPub = iAmHost ? raw : hs.pub;

    // Binds both public keys + the room code. Any MITM that swaps keys
    // produces a different transcript (and therefore a different code).
    const transcript = await sha256(
      textEnc.encode('reel-e2e-v1|'), textEnc.encode(state.code || ''), hostPub, guestPub
    );

    const okm     = await hkdfBytes(secret, transcript, 'reel-e2e-v1/keys', 64);
    const chunkKm = await hkdfBytes(secret, transcript, 'reel-e2e-v1/chunks', 64);
    const confRaw = await hkdfBytes(secret, transcript, 'reel-e2e-v1/confirm', 32);
    const confKey = await subtleCrypto.importKey('raw', confRaw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

    hs.peerPub = raw;
    hs.peerRole = msg.role;
    hs.transcript = transcript;
    hs.confKey = confKey;
    hs.keys = {
      send:      await importAesKey(iAmHost ? okm.subarray(0, 32)     : okm.subarray(32, 64)),
      recv:      await importAesKey(iAmHost ? okm.subarray(32, 64)    : okm.subarray(0, 32)),
      sendChunk: await importAesKey(iAmHost ? chunkKm.subarray(0, 32) : chunkKm.subarray(32, 64)),
      recvChunk: await importAesKey(iAmHost ? chunkKm.subarray(32, 64): chunkKm.subarray(0, 32))
    };

    const mac = new Uint8Array(await subtleCrypto.sign(
      'HMAC', confKey, concatBytes(transcript, textEnc.encode('|' + state.role))
    ));
    if (state.conn === conn) sendRaw({ t: 'auth', mac: b64encode(mac) });
  } catch (e) {
    failHandshake(conn, 'Encryption handshake failed');
  }
}

async function handshakeAuth(conn, msg) {
  const hs = conn._hs;
  if (!hs || !hs.keys || hs.verified) return;
  if (typeof msg.mac !== 'string' || msg.mac.length > 200) return;
  let mac;
  try { mac = b64decode(msg.mac); } catch (e) { return; }

  let ok = false;
  try {
    const expected = new Uint8Array(await subtleCrypto.sign(
      'HMAC', hs.confKey, concatBytes(hs.transcript, textEnc.encode('|' + hs.peerRole))
    ));
    ok = timingSafeEqual(mac, expected);
  } catch (e) { ok = false; }

  if (!ok) return failHandshake(conn, 'Key verification failed');
  hs.verified = true;
  completeHandshake(conn);
}

function completeHandshake(conn) {
  if (state.conn !== conn) return;
  const hs = conn._hs;
  clearTimeout(conn._hsTimer);

  state.secure = true;
  state.crypto = hs.keys;
  state.sas = sasFromTranscript(hs.transcript);
  state.securityFailure = false;

  const pretty = state.sas.slice(0, 3) + ' ' + state.sas.slice(3);
  addSystem('🔒 End-to-end encrypted · safety code ' + pretty);
  toast('Verify code ' + pretty + ' with your partner');

  send({ t: 'hello', name: state.username });
  if (state.role === 'host') shareMediaState();
  updatePartnerUI();
  updateVoiceUI();
  haptic(20);

  if (hs.readyRes) hs.readyRes(true);
}

function failHandshake(conn, reason) {
  if (state.conn !== conn) return;
  closeVoice(false);
  const hs = conn._hs;
  if (hs && hs.readyRes) hs.readyRes(false);
  state.securityFailure = true;
  resetCrypto();
  setStatus('off', 'Security check failed');
  addSystem('⚠️ ' + reason + ' — connection closed');
  toast(reason);
  try { conn.close(); } catch (e) {}
}

/* =========================================================
   PEER
   ========================================================= */
function destroyPeer() {
  closeVoice(false);
  if (state.conn) { try { state.conn.close(); } catch (e) {} }
  if (state.peer) { try { state.peer.destroy(); } catch (e) {} }
  state.conn = null;
  state.peer = null;
  state.connected = false;
  state.partnerOnline = false;
  state.partnerPeerId = '';
  state.recv = null;
  state.sending = false;
  resetCrypto();
}

function initPeer(id) {
  return new Promise((resolve, reject) => {
    destroyPeer();
    let settled = false;
    let peer;
    try {
      peer = new Peer(id, { debug: 1 });
    } catch (e) { reject(e); return; }

    state.peer = peer;

    peer.on('open', () => { settled = true; resolve(peer); });

    peer.on('error', err => {
      if (!settled) { settled = true; reject(err); return; }
      handlePeerError(err);
    });

    peer.on('connection', onIncoming);
    peer.on('call', onIncomingCall);

    peer.on('disconnected', () => {
      try { peer.reconnect(); } catch (e) {}
    });
  });
}

function handlePeerError(err) {
  const type = err && err.type;
  if (type === 'peer-unavailable') {
    if (state.role === 'guest') {
      // host may be reloading — keep retrying until they come back
      scheduleGuestReconnect();
    } else {
      toast('Room not found — check the code');
      setStatus('off', 'Room not found');
      setTimeout(leaveRoom, 1200);
    }
  } else if (type === 'network' || type === 'server-error' || type === 'socket-error') {
    setStatus('off', 'Reconnecting…');
    if (state.role === 'guest') scheduleGuestReconnect();
  } else if (type === 'unavailable-id') {
    // After a signalling drop the socket re-registers, but the server may
    // still hold the previous session → "ID is taken". The room should
    // re-arm itself instead of kicking both people out.
    if (state.role === 'host' && state.code) {
      toast('Reconnecting the room…');
      setStatus('off', 'Reconnecting…');
      rearmHost();
      return;
    }
    toast('Code collision — try again');
    setTimeout(leaveRoom, 900);
  }
}

/* Re-register the host peer with the same room id after a signalling drop.
   The guest's auto-reconnect then finds the room again. */
async function rearmHost(attempt = 0) {
  const code = state.code;
  if (!code) return;
  try {
    await initPeer(PREFIX + code);
  } catch (e) {
    if (attempt < 2) {
      setTimeout(() => rearmHost(attempt + 1), 2000);
      return;
    }
    toast('Could not restore the room');
    leaveRoom();
    return;
  }
  setStatus('waiting', 'Waiting for partner…');
}

function onIncoming(conn) {
  // Only the host accepts incoming connections
  if (state.role !== 'host') {
    try { conn.close(); } catch (e) {}
    return;
  }

  const incomingId = conn.metadata && conn.metadata.clientId;

  // If we already have a live partner connection
  if (state.conn && state.conn.open) {
    // Same guest reconnecting, or a channel the relay never closed (a phone
    // that slept leaves a zombie behind) → replace the stale connection
    if ((incomingId && state.partnerClientId && incomingId === state.partnerClientId) ||
        connIsZombie(state.conn)) {
      try { state.conn.close(); } catch (e) {}
      state.conn = null;
      wireConn(conn);
      return;
    }
    // Different person — room is full (host + 1 guest)
    conn.on('open', () => {
      try { conn.send({ t: 'full' }); } catch (e) {}
      setTimeout(() => { try { conn.close(); } catch (e) {} }, 500);
    });
    return;
  }

  // Replace any stale/closed connection
  if (state.conn) { try { state.conn.close(); } catch (e) {} state.conn = null; }
  wireConn(conn);
}

/* A DataConnection can report open while the underlying transport is gone —
   a phone that slept leaves exactly that behind. The host must replace it
   instead of answering "room is full" to the partner who just came back. */
function connIsZombie(conn) {
  const pc = conn.peerConnection;
  if (pc && (pc.connectionState === 'failed' || pc.connectionState === 'closed' ||
             pc.signalingState === 'closed')) return true;
  if (!state.secure && conn._openedAt && Date.now() - conn._openedAt > 15000) return true;
  return false;
}

function wireConn(conn) {
  state.conn = conn;
  conn._hs = null;        // a reused transport must start a fresh handshake
  state.partnerPeerId = conn.peer || '';
  let opened = false;

  conn.on('open', () => {
    opened = true;
    conn._openedAt = Date.now();
    state.connected = true;
    state.reconnectAttempts = 0;
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    haptic(18);
    updatePartnerUI();

    if (state.role === 'host') {
      state.partnerClientId = (conn.metadata && conn.metadata.clientId) || '';
    }

    // mark all pending as delivered
    state.messages.forEach(m => {
      if (m.from === 'me' && m.status === 'sent') { m.status = 'delivered'; paintTicks(m); }
    });

    // Everything else waits until the E2E handshake is verified.
    conn._pre = [];
    startHandshake(conn);
    conn._hsTimer = setTimeout(() => {
      if (state.conn === conn && !state.secure) failHandshake(conn, 'Encryption handshake timed out');
    }, HANDSHAKE_TIMEOUT);
  });

  conn.on('data', d => onData(conn, d));

  conn.on('close', () => {
    const wasConnected = state.connected;
    clearTimeout(conn._hsTimer);
    if (state.conn === conn) closeVoice(false);
    state.connected = false;
    state.partnerOnline = false;
    state.joinAnnounced = false;
    if (state.conn === conn) resetCrypto();
    state.recv = null;
    state.sending = false;
    updatePartnerUI();
    if (state.conn === conn) { state.conn = null; state.partnerPeerId = ''; }
    if (state.intentionalLeave) return;

    if (state.role === 'guest') {
      if (wasConnected) addSystem('Connection lost — reconnecting…');
      scheduleGuestReconnect();
    } else {
      addSystem((state.partnerName || 'Partner') + ' left the room');
      setStatus('waiting', 'Waiting for partner…');
    }
  });

  conn.on('error', () => {
    if (!opened && state.role === 'guest') scheduleGuestReconnect();
  });

  // if the connection never opens, retry (guest only)
  setTimeout(() => {
    if (!opened && state.conn === conn && !state.connected && !state.intentionalLeave) {
      try { conn.close(); } catch (e) {}
      if (state.role === 'guest') scheduleGuestReconnect();
    }
  }, 9000);
}

/* App data is encrypted and queued so frames keep their order. Voice control
   frames use their own queue so a long movie transfer never delays a call. */
function send(obj, urgent) {
  if (!state.secure || !state.crypto) return false;
  const run = async () => {
    if (!state.secure || !state.crypto) return;
    sendRaw(await encryptJSON(obj));
  };
  if (urgent) voiceTxChain = voiceTxChain.then(run).catch(() => {});
  else txChain = txChain.then(run).catch(() => {});
  return true;
}
const sendVoice = obj => send(obj, true);

/* File chunks share the same queue, so file-start / chunks / file-end stay ordered. */
function sendChunk(buf) {
  const p = txChain.then(async () => {
    if (!state.secure || !state.crypto) return;
    sendRaw(await encryptChunk(buf));
  }).catch(() => {});
  txChain = p;
  return p;
}

/* =========================================================
   DATA HANDLING
   ========================================================= */
function onData(conn, data) {
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) { onEncryptedChunk(conn, data); return; }
  if (!takeToken(rxBucket)) return;

  let msg = data;
  if (typeof data === 'string') {
    if (data.length > 8192) return;   // control frames are tiny
    try { msg = JSON.parse(data); } catch (e) { return; }
  }
  if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;

  switch (msg.t) {
    case 'key':
    case 'auth':
      if (msg.t === 'key' && conn._hs && conn._hs.verified) {
        // The partner rebuilt its side of the transport and is re-handshaking
        // on a connection object we still hold (mobile app switching). Restart
        // ours as well, otherwise we would keep the stale keys and go silent.
        if (Date.now() - (conn._hsAt || 0) < 1200) return;   // ignore replays
        conn._hs = null;
        if (state.conn === conn) resetCrypto();
        conn._pre = [msg];
        startHandshake(conn);
        return;
      }
      if (!conn._hs) {
        // Key material can arrive before we finished generating our own.
        if (!conn._pre) conn._pre = [];
        if (conn._pre.length < 4) conn._pre.push(msg);
        return;
      }
      dispatchHandshake(conn, msg);
      return;
    case 'enc':  queueIncoming(conn, msg); return;
    case 'full':
      // Only meaningful before the handshake, and only for the guest.
      if (state.role === 'guest') { toast('That room is already full'); setTimeout(leaveRoom, 1000); }
      return;
    default: return;            // unknown / unencrypted app frames are dropped
  }
}

/* Handshake frames must be processed strictly in order: 'auth' can only be
   checked after 'key' has produced the confirmation key. */
function dispatchHandshake(conn, msg) {
  conn._hsq = (conn._hsq || Promise.resolve())
    .then(() => (msg.t === 'key' ? handshakeKey(conn, msg) : handshakeAuth(conn, msg)))
    .catch(() => {});
}

function queueIncoming(conn, msg) {
  if (!conn._hs) return;
  rxChain = rxChain.then(async () => {
    if (!(await awaitSecure(conn))) return;
    await decryptMessage(conn, msg);
  }).catch(() => {});
}

/* Resolves once the handshake is verified (or failed). This lets frames that
   arrive while the HMAC check is still running wait instead of being dropped. */
function awaitSecure(conn) {
  const hs = conn._hs;
  if (!hs) return Promise.resolve(false);
  if (hs.verified) return Promise.resolve(true);
  if (!hs.readyP) hs.readyP = new Promise(res => { hs.readyRes = res; });
  return hs.readyP;
}

async function decryptMessage(conn, msg) {
  if (state.conn !== conn || !state.secure || !state.crypto) return;
  if (typeof msg.d !== 'string' || !msg.d || msg.d.length > 400000) return;

  let raw;
  try { raw = b64decode(msg.d); } catch (e) { return; }
  if (raw.length < 12 + 16) return;

  let plain;
  try {
    plain = await subtleCrypto.decrypt(
      { name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: DATA_AAD },
      state.crypto.recv, raw.subarray(12)
    );
  } catch (e) {
    return;                     // forged or tampered — silently drop
  }

  let obj;
  try { obj = JSON.parse(textDec.decode(plain)); } catch (e) { return; }
  if (obj && typeof obj === 'object') onSecureMessage(obj);
}

function onEncryptedChunk(conn, data) {
  if (state.conn !== conn || !conn._hs) return;
  // Before verification finishes, hold at most ~4 MB of frames.
  if (!state.secure) {
    conn._hs.pre = (conn._hs.pre || 0) + 1;
    if (conn._hs.pre > 256) return;
  }
  const u8 = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (u8.length < 1 + 12 + 16 || u8[0] !== CHUNK_MAGIC) return;

  const frame = u8.slice();     // transport reuses the buffer — copy it
  rxChain = rxChain.then(async () => {
    if (!(await awaitSecure(conn))) return;
    if (!state.secure || !state.crypto) return;
    let plain;
    try {
      plain = await subtleCrypto.decrypt(
        { name: 'AES-GCM', iv: frame.subarray(1, 13), additionalData: CHUNK_AAD },
        state.crypto.recvChunk, frame.subarray(13)
      );
    } catch (e) { return; }
    onChunk(plain);
  }).catch(() => {});
}

/* Everything below this point has been authenticated and decrypted. */
function onSecureMessage(data) {
  switch (data.t) {
    case 'hello': {
      const theirName = String(data.name || '').trim().slice(0, MAX_NAME);
      state.partnerName = theirName || 'Partner';
      state.partnerOnline = true;

      // Reject if both people picked the same name
      if (theirName && state.username &&
          theirName.toLowerCase() === state.username.toLowerCase()) {
        if (state.role === 'host') {
          state.partnerName = '';
          state.partnerOnline = false;
          send({ t: 'name-taken' });
          toast('That name is taken. Ask them to pick another.');
          setTimeout(() => {
            try { if (state.conn) state.conn.close(); } catch (e) {}
          }, 300);
          updatePartnerUI();
        } else {
          toast('That name is taken. Pick another.');
          setTimeout(leaveRoom, 900);
        }
        break;
      }

      announceJoin(state.partnerName);
      updatePartnerUI();
      break;
    }

    case 'name-taken':
      toast('That name is taken. Pick another.');
      setTimeout(leaveRoom, 900);
      break;

    case 'voice-invite':
      if (!takeToken(rxVoice)) break;
      onVoiceInvite();
      break;

    case 'voice-accept':
      onVoiceAccept();
      break;

    case 'voice-decline':
      onVoiceDecline();
      break;

    case 'voice-end':
      onVoiceEnd();
      break;

    case 'voice-busy':
      onVoiceBusy();
      break;

    case 'voice-mute':
      voice.peerMuted = data.m === true;
      updateVoiceUI();
      break;

    case 'voice-fp':
      if (typeof data.fp === 'string') onVoiceFingerprint(data.fp);
      break;

    case 'chat': {
      if (!isSafeId(data.id)) break;
      if (typeof data.text !== 'string' || !data.text || data.text.length > MAX_TEXT) break;
      if (state.messages.some(x => x.id === data.id)) break;   // ignore replays
      addMessage({
        id: data.id, text: data.text,
        ts: Number.isFinite(data.ts) ? data.ts : Date.now(),
        from: 'them', status: 'read', reply: cleanReply(data.reply)
      });
      send({ t: 'read', ids: [data.id] });
      if (isEmojiOnly(data.text)) floatEmojiText(data.text);
      haptic(8);
      break;
    }

    case 'react': {
      if (!isSafeId(data.id)) break;
      if (!QUICK_REACTIONS.includes(data.emoji)) break;   // whitelist only
      if (!takeToken(rxAnim)) break;
      const target = state.messages.find(x => x.id === data.id);
      if (!target) break;
      const added = setReaction(target, data.emoji, 'them', !!data.remove);
      if (added) { spawnFloatingEmoji(data.emoji, { count: 3 }); haptic(8); }
      break;
    }

    case 'float':
      if (!takeToken(rxAnim)) break;
      if (isEmojiOnly(data.e)) spawnFloatingEmoji(data.e, { count: 7 });
      break;

    case 'read': {
      const ids = Array.isArray(data.ids) ? data.ids.slice(0, 200) : [];
      ids.forEach(id => {
        if (!isSafeId(id)) return;
        const m = state.messages.find(x => x.id === id);
        if (m) { m.status = 'read'; paintTicks(m); }
      });
      break;
    }

    case 'typing':
      showRemoteTyping(data.on === true);
      break;

    /* Liveness probe, sent when the app comes back from the background: a
       frozen tab can leave a data channel "open" that is actually dead. */
    case 'ping': {
      if (!takeToken(rxPing)) break;
      const ts = Number(data.ts);
      if (!Number.isFinite(ts)) break;
      send({ t: 'pong', ts });
      break;
    }

    case 'pong': {
      const w = state.pingWait;
      if (!w || w.ts !== Number(data.ts)) break;
      state.pingWait = null;
      clearTimeout(w.timer);
      w.resolve(true);
      break;
    }

    case 'cmd': {
      if (data.a === 'rate') {
        if (data.v !== 1 && data.v !== 2) break;   // whitelist: only 1x and 2x
        applyCmd({ a: 'rate', v: data.v });
        break;
      }
      if (['play', 'pause', 'seek', 'tick'].indexOf(data.a) < 0) break;
      const t = Number(data.time);
      if (!Number.isFinite(t) || t < 0 || t > 7 * 24 * 3600) break;
      applyCmd({ a: data.a, time: t, p: data.p === true });
      break;
    }

    case 'media-url': {
      const url = safeMediaUrl(data.url);
      if (!url) break;
      state.localQueue = [];
      state.mediaUrl = url;
      state.mediaName = String(data.name || 'Shared movie').slice(0, MAX_MEDIA_NAME);
      setMedia(url, state.mediaName);
      break;
    }

    case 'file-start': {
      const size = Number(data.size);
      if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_BYTES) {
        toast('Partner tried to send a file that is too large');
        break;
      }
      if (!takeToken(rxFile)) break;
      const mime = String(data.mime || '');
      state.recv = {
        chunks: [], got: 0, size,
        mime: /^(video|audio)\//.test(mime) ? mime.slice(0, 80) : 'video/mp4',
        name: String(data.name || 'movie').slice(0, MAX_MEDIA_NAME)
      };
      showTransfer('Receiving movie…', 0);
      break;
    }

    case 'file-end': {
      const r = state.recv;
      state.recv = null;
      if (!r) break;
      if (r.got !== r.size) { toast('Transfer was incomplete'); hideTransfer(); break; }
      const blob = new Blob(r.chunks, { type: r.mime || 'video/mp4' });
      revokeBlob();
      state.localFile = null;
      state.mediaUrl = null;
      state.blobUrl = URL.createObjectURL(blob);
      setMedia(state.blobUrl, r.name);
      showTransfer('Receiving movie…', 1);
      setTimeout(hideTransfer, 500);
      break;
    }

    case 'pl-add': {
      if (!takeToken(rxPl)) break;
      const added = plAddRemote(data.items);
      if (added) addSystem('📋 ' + state.partnerName + ' added ' + added +
        ' video' + (added > 1 ? 's' : '') + ' to the playlist');
      break;
    }

    case 'pl-remove': {
      if (!takeToken(rxPl)) break;
      const i = Math.floor(Number(data.i));
      if (!(i >= 0) || i >= state.playlist.length) break;
      state.playlist.splice(i, 1);
      if (state.plIndex === i) state.plIndex = -1;
      else if (state.plIndex > i) state.plIndex--;
      renderPlaylistUI();
      break;
    }

    case 'pl-jump': {
      if (!takeToken(rxPl)) break;
      const i = Math.floor(Number(data.i));
      const it = state.playlist[i];
      if (!it) break;
      state.plIndex = i;
      renderPlaylistUI();
      break;
    }

    case 'pl-clear': {
      if (!takeToken(rxPl)) break;
      state.playlist = [];
      state.plIndex = -1;
      renderPlaylistUI();
      addSystem('📋 ' + (state.partnerName || 'Partner') + ' cleared the playlist');
      break;
    }

    case 'pl-sync': {
      // Only the host sends snapshots; the guest adopts the host's list.
      if (state.role !== 'guest' || !takeToken(rxPl)) break;
      const items = Array.isArray(data.items) ? data.items.slice(0, MAX_PLAYLIST) : [];
      const list = [];
      for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        const url = safeMediaUrl(it.url);
        if (!url) continue;
        list.push({ url, name: plCleanName(it.name) || guessMediaName(url) });
        if (list.length >= MAX_PLAYLIST) break;
      }
      state.playlist = list;
      const i = Math.floor(Number(data.i));
      state.plIndex = (i >= 0 && i < list.length) ? i : -1;
      renderPlaylistUI();
      break;
    }
  }
}

function onChunk(data) {
  if (!state.recv) return;
  const u8 = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

  // Never let a sender blow past the size it announced.
  if (state.recv.got + u8.byteLength > state.recv.size) {
    state.recv = null;
    hideTransfer();
    toast('Transfer rejected');
    return;
  }
  state.recv.chunks.push(u8.slice());
  state.recv.got += u8.byteLength;
  showTransfer('Receiving movie…', state.recv.size ? state.recv.got / state.recv.size : 0);
}

/* =========================================================
   LIVE VOICE
   Audio travels peer-to-peer over WebRTC (DTLS-SRTP), never
   through the signalling relay. Each call is bound to the
   authenticated data channel above by comparing the DTLS
   certificate fingerprints over the encrypted channel — a
   relay that swaps SDP cannot pass that check.
   ========================================================= */
const voice = {
  status: 'idle',        // idle | inviting | ringing | connecting | active
  call: null,
  localStream: null,
  remoteStream: null,
  muted: false,
  peerMuted: false,
  inviteTimer: null,
  connectTimer: null,
  fpTimer: null,
  myFp: '',
  peerFp: '',
  verified: false,
  audioCtx: null,
  analyser: null,
  meterData: null,
  meterRaf: 0,
  level: 0,
  dialogOpen: false
};

const voiceBar     = $('#voice-bar');
const voiceBars    = $$('#vb-wave i');
const voiceRemote  = $('#voice-remote');
const btnVoice     = $('#btn-voice');
const btnVoiceMute = $('#btn-voice-mute');
const btnVoiceEnd  = $('#btn-voice-end');

function micErrorMessage(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return 'Microphone permission is needed';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone found';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Microphone is busy in another app';
  }
  if (name === 'NotSupportedError' || !navigator.mediaDevices) {
    return 'Voice needs https:// or localhost';
  }
  return 'Could not start the microphone';
}

async function ensureMic() {
  if (voice.localStream &&
      voice.localStream.getAudioTracks().some(t => t.readyState === 'live')) {
    return voice.localStream;
  }
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    const e = new Error('unsupported'); e.name = 'NotSupportedError'; throw e;
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false
  });
  voice.localStream = stream;
  stream.getAudioTracks().forEach(t => { t.enabled = !voice.muted; });
  return stream;
}

function updateVoiceUI() {
  if (!voiceBar) return;
  const st = voice.status;
  const visible = st === 'inviting' || st === 'connecting' || st === 'active';

  voiceBar.classList.toggle('show', visible);
  voiceBar.classList.toggle('inviting', st === 'inviting');
  voiceBar.classList.toggle('connecting', st === 'connecting');
  voiceBar.classList.toggle('active', st === 'active');
  voiceBar.classList.toggle('muted', voice.muted);
  voiceBar.classList.toggle('verified', voice.verified);

  const who = state.partnerName || 'Partner';
  const nameEl = $('#vb-name');
  const initialEl = $('#vb-initial');
  const statusEl = $('#vb-status');
  if (nameEl) nameEl.textContent = who;
  if (initialEl) initialEl.textContent = (who.trim().charAt(0) || '?').toUpperCase();
  if (statusEl) {
    if (st === 'inviting') statusEl.textContent = 'Calling…';
    else if (st === 'active') {
      if (voice.muted) statusEl.textContent = 'You are muted';
      else if (voice.peerMuted) statusEl.textContent = who + ' is muted';
      else if (voice.verified) statusEl.textContent = '🔒 Encrypted · verified';
      else statusEl.textContent = '🔒 Encrypted voice';
    } else {
      statusEl.textContent = 'Connecting securely…';
    }
  }

  if (btnVoice) {
    const live = st === 'active';
    btnVoice.classList.toggle('live', live);
    btnVoice.classList.toggle('pending', st === 'inviting' || st === 'connecting');
    btnVoice.classList.toggle('ringing', st === 'ringing');
    btnVoice.classList.toggle('muted', voice.muted && (st === 'active' || st === 'connecting'));
    btnVoice.classList.toggle('off', !state.secure);
    const label = st === 'idle'
      ? 'Start voice call'
      : st === 'active'
        ? (voice.muted ? 'Unmute microphone' : 'Mute microphone')
        : st === 'inviting'
          ? 'Cancel voice call'
          : st === 'ringing'
            ? 'Incoming voice call'
            : 'Voice call';
    btnVoice.setAttribute('aria-label', label);
    btnVoice.setAttribute('title', label);
  }

  if (btnVoiceMute) {
    const on = st === 'active' || st === 'connecting';
    btnVoiceMute.disabled = !on;
    btnVoiceMute.style.opacity = on ? '' : '.45';
  }

  if (!visible && voiceBars.length) {
    voiceBars.forEach(b => { b.style.transform = ''; });
  }
}

async function startVoiceInvite() {
  if (!state.secure || !state.connected) { toast('Wait for the encrypted connection…'); return; }
  if (voice.status === 'active' || voice.status === 'connecting') { toggleVoiceMute(); return; }
  if (voice.status !== 'idle') return;

  try {
    await ensureMic();
  } catch (e) {
    toast(micErrorMessage(e));
    closeVoice(false);
    return;
  }
  if (!state.secure || !state.connected || voice.status !== 'idle') return;

  voice.muted = false;
  voice.peerMuted = false;
  voice.verified = false;
  voice.myFp = '';
  voice.peerFp = '';
  voice.status = 'inviting';
  sendVoice({ t: 'voice-invite' });
  updateVoiceUI();
  haptic(12);

  clearTimeout(voice.inviteTimer);
  voice.inviteTimer = setTimeout(() => {
    if (voice.status === 'inviting') { toast('No answer'); closeVoice(false); }
  }, 30000);
}

function askJoinVoice() {
  return showDialog({
    icon: '🎙️',
    title: 'Voice call',
    message: (state.partnerName || 'Your partner') +
      ' wants to talk. The audio is encrypted end-to-end and goes straight between your two browsers.',
    okText: 'Join',
    cancelText: 'Not now',
    danger: false
  });
}

async function acceptVoiceInvite() {
  if (voice.status !== 'ringing') return;

  try {
    await ensureMic();
  } catch (e) {
    toast(micErrorMessage(e));
    voice.status = 'idle';
    sendVoice({ t: 'voice-decline' });
    updateVoiceUI();
    return;
  }
  if (voice.status !== 'ringing') { closeVoice(false); return; }

  voice.muted = false;
  voice.peerMuted = false;
  voice.verified = false;
  voice.myFp = '';
  voice.peerFp = '';
  voice.status = 'connecting';
  sendVoice({ t: 'voice-accept' });
  updateVoiceUI();
  haptic(12);
  armVoiceConnectTimeout();
  if (state.role === 'host') maybeStartVoiceCall();
}

function maybeStartVoiceCall() {
  if (state.role !== 'host') return;
  if (voice.status !== 'connecting' || voice.call) return;
  if (!state.peer || state.peer.destroyed) return;
  if (!voice.localStream || !state.partnerPeerId) {
    closeVoice(true, 'Voice call failed');
    return;
  }

  let call;
  try {
    call = state.peer.call(state.partnerPeerId, voice.localStream, {
      metadata: { clientId: state.clientId }
    });
  } catch (e) {
    closeVoice(true, 'Voice call failed');
    return;
  }
  if (!call) { closeVoice(true, 'Voice call failed'); return; }

  voice.status = 'connecting';
  updateVoiceUI();
  attachVoiceCall(call);
  armVoiceConnectTimeout();
}

function attachVoiceCall(call) {
  if (voice.call) { try { call.close(); } catch (e) {} return; }
  voice.call = call;

  try {
    const pc = call.peerConnection;
    if (pc && pc.addEventListener) {
      pc.addEventListener('connectionstatechange', () => {
        if (voice.call !== call) return;
        if (pc.connectionState === 'failed') closeVoice(true, 'Voice connection failed');
      });
    }
  } catch (e) {}

  call.on('stream', stream => {
    if (voice.call !== call) return;
    voice.remoteStream = stream;
    try {
      voiceRemote.srcObject = stream;
      const p = voiceRemote.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
    clearTimeout(voice.connectTimer);
    voice.connectTimer = null;
    clearTimeout(voice.inviteTimer);
    voice.inviteTimer = null;
    voice.status = 'active';
    updateVoiceUI();
    startVoiceMeter(stream);
    startVoiceFingerprintCheck();
    haptic(14);
  });

  call.on('close', () => {
    if (voice.call !== call) return;
    voice.call = null;
    const was = voice.status;
    closeVoice(false);
    if (was === 'active' || was === 'connecting') toast('Voice call ended');
  });

  call.on('error', () => {
    if (voice.call !== call) return;
    closeVoice(true, 'Voice call failed');
  });

  startVoiceFingerprintCheck();
}

function armVoiceConnectTimeout() {
  clearTimeout(voice.connectTimer);
  voice.connectTimer = setTimeout(() => {
    if (voice.status === 'connecting') closeVoice(true, 'Voice call timed out');
  }, 25000);
}

function onVoiceInvite() {
  if (!state.secure) return;
  if (voice.status === 'active') { sendVoice({ t: 'voice-busy' }); return; }
  if (voice.status === 'connecting' || voice.status === 'ringing') return;

  // Both people tapped the mic at the same moment: meet in the middle.
  if (voice.status === 'inviting') {
    voice.status = 'connecting';
    voice.muted = false;
    voice.peerMuted = false;
    voice.verified = false;
    voice.myFp = '';
    voice.peerFp = '';
    sendVoice({ t: 'voice-accept' });
    updateVoiceUI();
    armVoiceConnectTimeout();
    if (state.role === 'host') maybeStartVoiceCall();
    return;
  }

  if (dlgResolve) { sendVoice({ t: 'voice-decline' }); return; }

  voice.status = 'ringing';
  updateVoiceUI();
  haptic(20);
  clearTimeout(voice.inviteTimer);
  voice.inviteTimer = setTimeout(() => {
    if (voice.status === 'ringing') {
      sendVoice({ t: 'voice-decline' });
      closeVoice(false);
    }
  }, 30000);

  voice.dialogOpen = true;
  askJoinVoice().then(ok => {
    voice.dialogOpen = false;
    clearTimeout(voice.inviteTimer);
    voice.inviteTimer = null;
    if (voice.status !== 'ringing') return;
    if (ok) acceptVoiceInvite();
    else {
      voice.status = 'idle';
      sendVoice({ t: 'voice-decline' });
      updateVoiceUI();
    }
  });
}

function onVoiceAccept() {
  if (!state.secure) return;
  if (voice.status === 'inviting') {
    voice.status = 'connecting';
    updateVoiceUI();
    armVoiceConnectTimeout();
  }
  if (voice.status === 'connecting' && state.role === 'host') maybeStartVoiceCall();
}

function onVoiceDecline() {
  if (voice.status === 'inviting' || voice.status === 'connecting') {
    closeVoice(false, 'Voice call declined');
  }
}

function onVoiceEnd() {
  if (voice.status === 'idle') return;
  const was = voice.status;
  closeVoice(false);
  if (was === 'inviting') toast('Call cancelled');
  else if (was === 'active' || was === 'connecting') toast('Voice call ended');
}

function onVoiceBusy() {
  if (voice.status === 'inviting' || voice.status === 'connecting') {
    closeVoice(false, 'They are already on a voice call');
  }
}

function toggleVoiceMute() {
  if (voice.status !== 'active' && voice.status !== 'connecting') return;
  voice.muted = !voice.muted;
  if (voice.localStream) {
    voice.localStream.getAudioTracks().forEach(t => { t.enabled = !voice.muted; });
  }
  sendVoice({ t: 'voice-mute', m: voice.muted });
  haptic(10);
  updateVoiceUI();
}

function closeVoice(notify, message) {
  const was = voice.status !== 'idle';
  clearTimeout(voice.inviteTimer); voice.inviteTimer = null;
  clearTimeout(voice.connectTimer); voice.connectTimer = null;
  clearInterval(voice.fpTimer); voice.fpTimer = null;

  if (voice.dialogOpen) {
    voice.dialogOpen = false;
    if (dlgResolve) closeDialog(false);
  }

  if (notify && was && state.secure && state.conn && state.conn.open) {
    sendVoice({ t: 'voice-end' });
  }

  const call = voice.call;
  voice.call = null;
  if (call) { try { call.close(); } catch (e) {} }

  if (voice.localStream) {
    voice.localStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
    voice.localStream = null;
  }
  if (voice.remoteStream) {
    voice.remoteStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
    voice.remoteStream = null;
  }
  try { voiceRemote.pause(); } catch (e) {}
  try { voiceRemote.srcObject = null; } catch (e) {}

  stopVoiceMeter();
  voice.status = 'idle';
  voice.muted = false;
  voice.peerMuted = false;
  voice.verified = false;
  voice.myFp = '';
  voice.peerFp = '';
  voice.level = 0;
  if (voiceBar) voiceBar.style.setProperty('--level', '0');
  updateVoiceUI();
  if (message) toast(message);
}

/* ---------- DTLS fingerprint binding ---------- */
function sdpFingerprint(sdp) {
  const m = /a=fingerprint:sha-256\s+([0-9a-f:]+)/i.exec(sdp || '');
  return m ? m[1].toUpperCase() : '';
}

function checkVoiceFingerprint() {
  const call = voice.call;
  const pc = call && call.peerConnection;
  if (!pc) return false;

  const local = pc.localDescription ? sdpFingerprint(pc.localDescription.sdp) : '';
  const remote = pc.remoteDescription ? sdpFingerprint(pc.remoteDescription.sdp) : '';

  if (local && local !== voice.myFp) {
    voice.myFp = local;
    sendVoice({ t: 'voice-fp', fp: local });
  }

  if (remote && voice.peerFp) {
    if (remote !== voice.peerFp) {
      clearInterval(voice.fpTimer); voice.fpTimer = null;
      addSystem('⚠️ Voice security check failed — call closed');
      closeVoice(true, 'Voice security check failed');
      return true;
    }
    if (!voice.verified) {
      voice.verified = true;
      updateVoiceUI();
      addSystem('🎙️ Voice secured · DTLS fingerprint verified');
    }
    // Keep ticking until our own fingerprint has been sent too; otherwise the
    // peer can never verify us if its SDP was not ready on the first tick.
    if (voice.myFp) {
      clearInterval(voice.fpTimer); voice.fpTimer = null;
    }
    return true;
  }
  return false;
}

function onVoiceFingerprint(fp) {
  const value = String(fp).trim();
  if (!/^([0-9a-f]{2}:){31}[0-9a-f]{2}$/i.test(value)) return;
  voice.peerFp = value.toUpperCase();
  checkVoiceFingerprint();
}

function startVoiceFingerprintCheck() {
  clearInterval(voice.fpTimer);
  voice.fpTimer = null;
  let tries = 0;
  const tick = () => {
    if (voice.status !== 'active' && voice.status !== 'connecting') {
      clearInterval(voice.fpTimer); voice.fpTimer = null; return;
    }
    checkVoiceFingerprint();
    if (++tries >= 60) {
      clearInterval(voice.fpTimer); voice.fpTimer = null;
      if (!(voice.verified && voice.myFp)) {
        addSystem('⚠️ Voice verification timed out — call closed');
        closeVoice(true, 'Voice verification timed out');
      }
    }
  };
  tick();
  if (!(voice.verified && voice.myFp) &&
      (voice.status === 'active' || voice.status === 'connecting')) {
    voice.fpTimer = setInterval(tick, 250);
  }
}

/* ---------- live audio level (speaking glow + waveform) ---------- */
function startVoiceMeter(stream) {
  stopVoiceMeter();
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    voice.audioCtx = new AC();
    try { voice.audioCtx.resume(); } catch (e) {}
    const source = voice.audioCtx.createMediaStreamSource(stream);
    const analyser = voice.audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.78;
    source.connect(analyser);
    voice.analyser = analyser;
    voice.meterData = new Uint8Array(analyser.frequencyBinCount);

    const mult = [0.58, 0.82, 1, 0.78, 0.55];
    const idle = [0.26, 0.48, 0.68, 0.44, 0.6, 0.36, 0.24];
    const count = voiceBars.length;
    const tick = () => {
      if (!voice.analyser || voice.status !== 'active') return;
      analyser.getByteFrequencyData(voice.meterData);
      let sum = 0;
      for (let i = 0; i < voice.meterData.length; i++) sum += voice.meterData[i];
      let level = Math.min(1, Math.pow((sum / voice.meterData.length / 255) * 3.4, 0.72));
      if (voice.peerMuted) level = 0;
      voice.level = level;
      voiceBar.style.setProperty('--level', level.toFixed(3));
      const wobbleBase = Date.now() / 190;
      for (let i = 0; i < count; i++) {
        const wobble = 0.82 + 0.18 * Math.sin(wobbleBase + i * 1.7);
        const base = idle[i % idle.length];
        const h = Math.min(1, base + Math.min(1, level * 2.4) * mult[i % mult.length] * 0.58 * wobble);
        voiceBars[i].style.transform = 'scaleY(' + h.toFixed(3) + ')';
      }
      voice.meterRaf = requestAnimationFrame(tick);
    };
    tick();
  } catch (e) {}
}

function stopVoiceMeter() {
  if (voice.meterRaf) { cancelAnimationFrame(voice.meterRaf); voice.meterRaf = 0; }
  voice.analyser = null;
  voice.meterData = null;
  voice.level = 0;
  if (voice.audioCtx) { try { voice.audioCtx.close(); } catch (e) {} voice.audioCtx = null; }
  voiceBars.forEach(b => { b.style.transform = ''; });
}

/* ---------- incoming MediaConnection (guest answers) ---------- */
function onIncomingCall(call) {
  const reject = () => { try { call.close(); } catch (e) {} };

  if (!state.secure || state.role !== 'guest') { reject(); return; }
  if (voice.status !== 'connecting' && voice.status !== 'inviting') { reject(); return; }
  if (voice.call) { reject(); return; }
  if (!call.peer || (state.partnerPeerId && call.peer !== state.partnerPeerId)) { reject(); return; }
  if (!voice.localStream) {
    reject();
    closeVoice(false);
    toast('Microphone is not ready');
    return;
  }

  try {
    call.answer(voice.localStream);
  } catch (e) {
    reject();
    closeVoice(false);
    toast('Could not answer the call');
    return;
  }

  voice.status = 'connecting';
  updateVoiceUI();
  armVoiceConnectTimeout();
  attachVoiceCall(call);
}

/* ---------- voice buttons ---------- */
btnVoice.addEventListener('click', () => {
  haptic(10);
  if (!state.secure || !state.connected) {
    toast('Wait for the encrypted connection…');
    return;
  }
  if (voice.status === 'idle') startVoiceInvite();
  else if (voice.status === 'inviting') closeVoice(true, 'Call cancelled');
  else if (voice.status === 'active' || voice.status === 'connecting') toggleVoiceMute();
  else if (voice.status === 'ringing') toast('Answer the call first');
});

btnVoiceMute.addEventListener('click', () => { haptic(8); toggleVoiceMute(); });
btnVoiceEnd.addEventListener('click', () => { haptic(10); closeVoice(true, 'Voice call ended'); });

/* =========================================================
   ROOM LIFECYCLE
   ========================================================= */
function readUsername() {
  return ($('#name-input').value || '').trim().slice(0, MAX_NAME);
}

async function hostRoom() {
  const name = readUsername();
  if (!name) { toast('Enter your name first'); $('#name-input').focus(); return; }
  state.username = name;

  const code = genCode();
  state.role = 'host';
  state.intentionalLeave = false;
  state.reconnectAttempts = 0;
  try {
    await initPeer(PREFIX + code);
  } catch (e) {
    state.role = null;
    toast('Could not start room. Check your connection.');
    return;
  }
  state.code = code;
  saveSession();
  enterRoom('Room created · share the code');
}

async function joinRoom(rawCode) {
  const name = readUsername();
  if (!name) { toast('Enter your name first'); $('#name-input').focus(); return; }
  state.username = name;

  const code = cleanCode(rawCode);
  if (code.length !== CODE_LEN) { toast('Enter all 12 characters'); return; }

  state.role = 'guest';
  state.intentionalLeave = false;
  state.reconnectAttempts = 0;
  try {
    await initPeer(null);
  } catch (e) {
    state.role = null;
    toast('Network error. Try again.');
    return;
  }

  state.code = code;
  saveSession();
  enterRoom('Joining room…');

  setStatus('waiting', 'Connecting…');
  openGuestConn();
}

function enterRoom(sysText) {
  closeVoice(false);
  $('#code-text').textContent = formatCode(state.code);
  chat.innerHTML = '';
  state.messages = [];
  state.mediaLoaded = false;
  state.localFile = null;
  state.mediaUrl = null;
  state.partnerName = '';
  state.partnerOnline = false;
  state.joinAnnounced = false;
  state.securityFailure = false;
  state.partnerPeerId = '';
  hiddenSince = document.hidden ? Date.now() : 0;
  if (!state.conn) resetCrypto();
  destroyYouTube();
  revokeBlob();
  hideTransfer();
  $('#tap-play').classList.remove('show');
  videoWrap.classList.remove('has-media');
  video.removeAttribute('src');
  try { video.load(); } catch (e) {}
  resetScrub();
  showRoomView();
  updatePartnerUI();
  if (sysText) addSystem(sysText);
}

function leaveRoom() {
  state.intentionalLeave = true;
  closeVoice(false);
  // a fullscreen room shouldn't stay fullscreen on the home screen
  exitFullscreen();
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  state.reconnectAttempts = 0;
  hiddenSince = 0;
  destroyPeer();
  clearSession();
  state.role = null;
  state.code = '';
  state.username = '';
  state.partnerName = '';
  state.partnerOnline = false;
  state.joinAnnounced = false;
  state.securityFailure = false;
  state.partnerClientId = '';
  state.partnerPeerId = '';
  state.messages = [];
  chat.innerHTML = '';
  destroyYouTube();
  revokeBlob();
  state.mediaLoaded = false;
  state.localFile = null;
  state.mediaUrl = null;
  state.playlist = [];
  state.plIndex = -1;
  state.localQueue = [];
  plLastAdvance = 0;
  $('#tap-play').classList.remove('show');
  videoWrap.classList.remove('has-media');
  video.removeAttribute('src');
  try { video.load(); } catch (e) {}
  hideTransfer();
  closeSheet();
  sampleVideoBars(true);
  clearReply();
  showHome();
  $('#code-input').value = '';
  sendBtn.disabled = true;
  msgInput.value = '';
  msgInput.style.height = 'auto';
}

function setStatus(kind, text) {
  const dot = $('#status-dot');
  dot.className = 'dot' + (kind === 'online' ? ' online' : kind === 'off' ? ' off' : '');
  $('#status-text').textContent = text;
}

function updatePartnerUI() {
  if (state.connected && !state.secure) {
    setStatus('waiting', 'Securing connection…');
  } else if (state.secure && state.partnerOnline && state.partnerName) {
    setStatus('online', '🔒 ' + state.partnerName + ' · online');
  } else if (state.secure && state.connected) {
    setStatus('online', '🔒 Connected');
  } else if (state.partnerName) {
    setStatus('off', state.partnerName + ' · offline');
  } else {
    setStatus('waiting', 'Waiting for partner…');
  }
  updateVoiceUI();
}

/* Announce the partner by name, once per join. */
function announceJoin(name) {
  if (state.joinAnnounced) return;
  state.joinAnnounced = true;
  const who = name || 'Partner';
  addSystem(state.role === 'guest' ? 'Connected to ' + who : who + ' joined the room');
}

/* ---------- coming back from the background (phones) ----------
   A hidden mobile tab is frozen: timers stop, the signalling socket can drop
   and the data channel can die without ever firing "close". Reconnecting while
   frozen is impossible, so the old code burned its 15 attempts and closed the
   room while the app sat in the background. Now the retry clock pauses while
   hidden, and on the way back we probe the channel and rebuild it at once. */
const PING_MS = 2500;
let hiddenSince = 0;

function pingPartner() {
  return new Promise(resolve => {
    if (!state.secure || !state.conn || !state.conn.open) { resolve(false); return; }
    if (state.pingWait) { resolve(true); return; }   // one probe at a time
    const ts = Date.now();
    const timer = setTimeout(() => {
      if (state.pingWait && state.pingWait.ts === ts) {
        state.pingWait = null;
        resolve(false);
      }
    }, PING_MS);
    state.pingWait = { ts, timer, resolve };
    if (!send({ t: 'ping', ts })) {
      state.pingWait = null;
      clearTimeout(timer);
      resolve(false);
    }
  });
}

/* Tear down a channel we know is dead without waiting for its close timeout. */
function dropDeadConn() {
  const c = state.conn;
  state.pingWait = null;
  if (!c) return;
  if (state.conn === c) { state.conn = null; state.partnerPeerId = ''; }
  state.connected = false;
  state.partnerOnline = false;
  state.joinAnnounced = false;
  resetCrypto();
  state.recv = null;
  state.sending = false;
  try { c.close(); } catch (e) {}
  updatePartnerUI();
}

function onAppHidden() {
  if (hiddenSince) return;
  hiddenSince = Date.now();
  // no point running the retry clock inside a frozen page
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
}

async function onAppVisible() {
  if (!hiddenSince) return;
  hiddenSince = 0;
  if (state.intentionalLeave || !state.code || !state.role) return;

  // Being away is not a failed attempt: restart the ladder from scratch and
  // ignore the backoff delay so the room is back before the user notices.
  state.reconnectAttempts = 0;
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;

  const alive = await pingPartner();
  if (alive) { updatePartnerUI(); return; }

  dropDeadConn();

  if (state.role === 'guest') {
    if (state.peer && state.peer.disconnected) {
      try { state.peer.reconnect(); } catch (e) {}
    }
    doGuestConnect();          // immediate, no backoff
    clearTimeout(state.reconnectTimer);   // the drop may have queued one
    state.reconnectTimer = null;
    return;
  }

  // Host: re-register the room if the signalling socket went away, otherwise
  // just wait — the guest reconnects to the same code and replaces the channel.
  if (!state.peer || state.peer.destroyed) {
    rearmHost();
    return;
  }
  if (state.peer.disconnected) {
    try { state.peer.reconnect(); } catch (e) {}
    setTimeout(() => {
      if (!state.intentionalLeave && state.code && state.peer && state.peer.disconnected) rearmHost();
    }, 2500);
  }
}

/* ---------- auto reconnect ---------- */
function scheduleGuestReconnect() {
  if (state.intentionalLeave || state.role !== 'guest' || state.connected) return;
  if (state.securityFailure) return;      // never auto-retry a failed handshake
  if (state.reconnectTimer) return;

  // A hidden phone tab is frozen: retrying now is pointless and every failed
  // attempt would burn the ladder. onAppVisible() retries the moment we return.
  if (document.hidden) { hiddenSince = hiddenSince || Date.now(); return; }

  if (state.reconnectAttempts >= MAX_RECONNECT) {
    toast('Room closed');
    state.intentionalLeave = true;
    setTimeout(() => { leaveRoom(); }, 700);
    return;
  }

  const delay = Math.min(1200 * Math.pow(1.5, state.reconnectAttempts), 8000);
  state.reconnectAttempts++;
  setStatus('off', 'Reconnecting… (' + state.reconnectAttempts + ')');
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    doGuestConnect();
  }, delay);
}

function doGuestConnect() {
  if (state.intentionalLeave || state.role !== 'guest' || state.connected) return;

  const needNewPeer = !state.peer || state.peer.destroyed;
  if (needNewPeer) {
    initPeer(null).then(() => {
      if (state.intentionalLeave || state.role !== 'guest') return;
      openGuestConn();
    }).catch(() => scheduleGuestReconnect());
    return;
  }

  if (state.peer.disconnected) {
    try { state.peer.reconnect(); } catch (e) {}
  }
  openGuestConn();
}

function openGuestConn() {
  if (state.intentionalLeave || state.role !== 'guest' || state.connected) return;
  try {
    const conn = state.peer.connect(PREFIX + state.code, {
      reliable: true,
      // No name/identity in metadata: the signalling relay must not learn it.
      metadata: { clientId: state.clientId }
    });
    wireConn(conn);
  } catch (e) {
    scheduleGuestReconnect();
  }
}

async function resumeSession() {
  const s = loadSession();
  if (!s || !s.code || !s.role) return false;

  if (s.username) { state.username = s.username; $('#name-input').value = s.username; }
  state.code = s.code;
  state.role = s.role;
  state.intentionalLeave = false;
  state.reconnectAttempts = 0;

  if (s.role === 'host') {
    let ok = false;
    for (let i = 0; i < 3 && !ok; i++) {
      try {
        await initPeer(PREFIX + s.code);
        ok = true;
      } catch (e) {
        if (e && e.type === 'unavailable-id' && i < 2) {
          await new Promise(r => setTimeout(r, 1200));
        } else break;
      }
    }
    if (!ok) {
      clearSession();
      state.role = null; state.code = '';
      return false;
    }
    enterRoom('Room restored · share the code');
    setStatus('waiting', 'Waiting for partner…');
    return true;
  }

  // guest
  try {
    await initPeer(null);
  } catch (e) {
    clearSession();
    state.role = null; state.code = '';
    return false;
  }
  enterRoom('Reconnecting to room…');
  setStatus('waiting', 'Connecting…');
  openGuestConn();
  return true;
}

/* =========================================================
   HLS (.m3u8) - hls.js loaded lazily from unpkg when needed.
   Safari plays HLS natively; everyone else gets hls.js.
   ========================================================= */
let hls = null;
let hlsLoading = null;

function destroyHls() {
  if (!hls) return;
  try { hls.destroy(); } catch (e) {}
  hls = null;
}

function isHlsUrl(u) {
  return typeof u === 'string' && /\.m3u8($|[?#])/i.test(u);
}

function loadHlsLib() {
  if (window.Hls) return Promise.resolve(true);
  if (hlsLoading) return hlsLoading;
  hlsLoading = new Promise(res => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/hls.js@1.5.13/dist/hls.min.js';
    s.onload = () => res(true);
    s.onerror = () => res(false);
    document.head.appendChild(s);
  });
  return hlsLoading;
}

async function attachHls(url) {
  // Safari (and iOS) can play HLS directly
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    video.load();
    video.play().catch(() => { $('#tap-play').classList.add('show'); });
    return;
  }
  const ok = await loadHlsLib();
  if (!ok || !window.Hls || !window.Hls.isSupported()) {
    video.src = url;      // best effort - let the browser try
    video.load();
    video.play().catch(() => { $('#tap-play').classList.add('show'); });
    return;
  }
  destroyHls();
  hls = new window.Hls({ enableWorker: true });
  hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
    video.play().catch(() => { $('#tap-play').classList.add('show'); });
  });
  hls.on(window.Hls.Events.ERROR, (ev, d) => {
    if (d && d.fatal) { toast('Could not play this stream'); destroyHls(); }
  });
  hls.loadSource(url);
  hls.attachMedia(video);
}

/* =========================================================
   MEDIA
   ========================================================= */
function revokeBlob() {
  if (!state.blobUrl) return;
  try { URL.revokeObjectURL(state.blobUrl); } catch (e) {}
  state.blobUrl = null;
}

function setMedia(url, name) {
  const ytId = parseYouTube(url);
  const isBlob = /^blob:/i.test(url);

  // switching to a link / YouTube → the previous local file is no longer ours
  if (!isBlob) {
    state.localFile = null;
    revokeBlob();
  }

  if (ytId) {
    destroyHls();
    state.mediaUrl = url;
    loadYouTube(ytId, name);
    return;
  }

  destroyYouTube();
  destroyHls();
  $('#tap-play').classList.remove('show');
  hideTransfer();
  try { video.pause(); } catch (e) {}
  resetScrub();
  state.mediaUrl = isBlob ? null : url;
  state.mediaName = String(name || 'Movie').slice(0, MAX_MEDIA_NAME);
  state.mediaLoaded = true;
  videoWrap.classList.add('has-media');
  sampleVideoBars(true);
  addSystem('🎬 ' + state.mediaName);
  if (isHlsUrl(url)) {
    attachHls(url);
    return;
  }
  video.src = url;
  video.load();
  // try autoplay (may be blocked)
  video.play().catch(() => { $('#tap-play').classList.add('show'); });
}

function shareMediaState() {
  if (state.localFile) {
    sendFile(state.localFile);
  } else if (state.mediaUrl) {
    send({ t: 'media-url', url: state.mediaUrl, name: state.mediaName });
  }
  if (state.playlist.length) {
    // guest adopts the host's list on (re)connect
    send({ t: 'pl-sync', items: state.playlist.slice(0, MAX_PLAYLIST), i: state.plIndex });
  }
  if (state.mediaLoaded) {
    const t = state.isYT ? (ytReady ? ytPlayer.getCurrentTime() : 0) : video.currentTime;
    const paused = state.isYT ? (!ytReady || ytPlayer.getPlayerState() !== 1) : video.paused;
    send({ t: 'cmd', a: 'seek', time: t });
    send({ t: 'cmd', a: paused ? 'pause' : 'play', time: t });
  }
}

/* =========================================================
   ASPECT RATIO - how a direct video fills the player box.
   It depends on *your* screen, so it is a local preference and
   is not synced. YouTube uses its own player, so it does not
   apply there (the button is hidden and the frame stays 16:9).
   ========================================================= */
const ASPECT_KEY = 'reel.aspect.v1';
const ASPECT_MODES = [
  { id: 'fit',     label: 'Fit' },
  { id: 'fill',    label: 'Fill' },
  { id: 'stretch', label: 'Stretch' },
];
const ASPECT_FRAMES = [
  { id: 'auto',  label: 'Match video' },
  { id: '16-9',  label: '16:9' },
  { id: '4-3',   label: '4:3' },
  { id: '1-1',   label: '1:1' },
  { id: '21-9',  label: '21:9' },
];

function loadAspect() {
  const def = { mode: 'fit', frame: '16-9' };
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(ASPECT_KEY) || 'null'); } catch (e) {}
  if (!raw || typeof raw !== 'object') return def;
  return {
    mode: ASPECT_MODES.some(m => m.id === raw.mode) ? raw.mode : def.mode,
    frame: ASPECT_FRAMES.some(f => f.id === raw.frame) ? raw.frame : def.frame,
  };
}

function saveAspect() {
  try { localStorage.setItem(ASPECT_KEY, JSON.stringify(state.aspect)); } catch (e) {}
}

const BAR_SIZE = 96;
let barCanvas = null;
let barCtx = null;
let videoBars = { l: 0, t: 0, samples: 0 };
let lastBarSampleAt = 0;

function applyFillTransform() {
  if (state.aspect.mode !== 'fill') {
    video.style.transform = '';
    return;
  }
  video.style.objectFit = 'fill';
  const sx = 1 / Math.max(0.4, 1 - 2 * videoBars.l);
  const sy = 1 / Math.max(0.4, 1 - 2 * videoBars.t);
  video.style.transform = (sx > 1.01 || sy > 1.01)
    ? `scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`
    : '';
}

function sampleVideoBars(reset) {
  if (reset) {
    videoBars = { l: 0, t: 0, samples: 0 };
    lastBarSampleAt = 0;
    applyFillTransform();
    return;
  }
  if (state.isYT || !state.mediaLoaded || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;

  if (!barCanvas) {
    barCanvas = document.createElement('canvas');
    barCanvas.width = BAR_SIZE;
    barCanvas.height = BAR_SIZE;
    barCtx = barCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (!barCtx) return;

  let data;
  try {
    barCtx.drawImage(video, 0, 0, BAR_SIZE, BAR_SIZE);
    data = barCtx.getImageData(0, 0, BAR_SIZE, BAR_SIZE).data;
  } catch (e) {
    return;
  }

  // Ignore dark/fade-to-black frames unless the center region has visible picture
  let lit = 0;
  for (let y = 24; y < 72; y++) {
    for (let x = 24; x < 72; x++) {
      const i = (y * BAR_SIZE + x) * 4;
      if (Math.max(data[i], data[i + 1], data[i + 2]) > 22) lit++;
    }
  }
  if (lit / (48 * 48) < 0.15) return;

  const isBlackCol = x => {
    let dark = 0;
    for (let y = 10; y <= 85; y++) {
      const i = (y * BAR_SIZE + x) * 4;
      if (Math.max(data[i], data[i + 1], data[i + 2]) <= 18) dark++;
    }
    return dark / 76 >= 0.95;
  };
  const isBlackRow = y => {
    let dark = 0;
    for (let x = 10; x <= 85; x++) {
      const i = (y * BAR_SIZE + x) * 4;
      if (Math.max(data[i], data[i + 1], data[i + 2]) <= 18) dark++;
    }
    return dark / 76 >= 0.95;
  };

  let l = 0, r = 0, t = 0, b = 0;
  while (l <= 26 && isBlackCol(l)) l++;
  while (r <= 26 && isBlackCol(BAR_SIZE - 1 - r)) r++;
  while (t <= 26 && isBlackRow(t)) t++;
  while (b <= 26 && isBlackRow(BAR_SIZE - 1 - b)) b++;

  let lr = Math.min(l, r) / BAR_SIZE;
  let tb = Math.min(t, b) / BAR_SIZE;
  lr = lr >= 0.015 ? Math.min(0.28, lr + 0.005) : 0;
  tb = tb >= 0.015 ? Math.min(0.28, tb + 0.005) : 0;

  if (videoBars.samples === 0) {
    videoBars.l = lr;
    videoBars.t = tb;
  } else {
    videoBars.l = Math.min(videoBars.l, lr);
    videoBars.t = Math.min(videoBars.t, tb);
  }
  videoBars.samples++;
  applyFillTransform();
}

function applyAspect() {
  const a = state.aspect;
  videoWrap.classList.toggle('ar-fill', a.mode === 'fill');
  videoWrap.classList.toggle('ar-stretch', a.mode === 'stretch');
  video.style.objectFit = (a.mode === 'fill' || a.mode === 'stretch') ? 'fill' : 'contain';
  applyFillTransform();
  if (a.mode === 'fill' && videoBars.samples === 0) sampleVideoBars();
  ASPECT_FRAMES.forEach(f => videoWrap.classList.toggle('frame-' + f.id, a.frame === f.id));
  videoWrap.classList.remove('frame-tall');
  if (a.frame === 'auto') updateAutoFrame();
  else videoWrap.style.aspectRatio = '';
}

/* "Match video": the player box copies the clip's own shape. */
function updateAutoFrame() {
  if (state.aspect.frame !== 'auto') return;
  if (appFullscreenEl() === videoWrap || isFakeLandscape()) {
    videoWrap.style.aspectRatio = '';
    videoWrap.classList.remove('frame-tall');
    return;
  }
  const w = video.videoWidth | 0, h = video.videoHeight | 0;
  if (w > 0 && h > 0) {
    videoWrap.style.aspectRatio = w + ' / ' + h;
    videoWrap.classList.toggle('frame-tall', w / h < 0.95);
  } else {
    videoWrap.style.aspectRatio = '';
    videoWrap.classList.remove('frame-tall');
  }
}
video.addEventListener('loadedmetadata', updateAutoFrame);
video.addEventListener('resize', updateAutoFrame);
video.addEventListener('loadeddata', () => sampleVideoBars());
video.addEventListener('seeked', () => sampleVideoBars());
video.addEventListener('play', () => sampleVideoBars());
video.addEventListener('timeupdate', () => {
  if (state.aspect.mode !== 'fill' || videoBars.samples >= 15) return;
  const now = Date.now();
  if (now - lastBarSampleAt < 1200) return;
  lastBarSampleAt = now;
  sampleVideoBars();
});

function openAspectSheet() {
  haptic(8);
  const a = state.aspect;
  openSheet(`
    <h3>Aspect ratio</h3>
    <p>For links and files. YouTube plays in its own player, so this does not apply there.</p>
    <div class="ar-group">
      <span class="ar-label">Fit</span>
      <div class="ar-chips">${ASPECT_MODES.map(m =>
        `<button class="ar-chip${a.mode === m.id ? ' on' : ''}" data-mode="${m.id}">${m.label}</button>`).join('')}</div>
    </div>
    <div class="ar-group">
      <span class="ar-label">Frame</span>
      <div class="ar-chips">${ASPECT_FRAMES.map(f =>
        `<button class="ar-chip${a.frame === f.id ? ' on' : ''}" data-frame="${f.id}">${f.label}</button>`).join('')}</div>
    </div>
    <p class="ar-note"><b>Fit</b> keeps the original proportions (with black bars if needed), <b>Fill</b> fills every side of the frame while keeping the whole picture inside (nothing is cut off), <b>Stretch</b> stretches across the frame. <b>Frame</b> changes the shape of the player box itself — <b>Match video</b> uses the clip's own shape. Saved on this device; your partner keeps their own.</p>
    <button class="btn ghost" id="ar-reset">Reset to default</button>
  `);

  const pick = (key, id) => {
    if (state.aspect[key] === id) return;
    state.aspect[key] = id;
    haptic(6);
    saveAspect();
    applyAspect();
    openAspectSheet();          // repaint the selection
  };
  sheetBody.querySelectorAll('[data-mode]').forEach(b =>
    b.addEventListener('click', () => pick('mode', b.dataset.mode)));
  sheetBody.querySelectorAll('[data-frame]').forEach(b =>
    b.addEventListener('click', () => pick('frame', b.dataset.frame)));
  $('#ar-reset').addEventListener('click', () => {
    state.aspect = { mode: 'fit', frame: '16-9' };
    haptic(6);
    saveAspect();
    applyAspect();
    openAspectSheet();
  });
}

state.aspect = loadAspect();
applyAspect();
$('#btn-aspect').addEventListener('click', () => openAspectSheet());

/* =========================================================
   PLAYLIST - synced through the encrypted channel.
   Both people can add, remove and jump. The host's list
   wins on (re)connect via the pl-sync snapshot.
   ========================================================= */
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function plCleanName(n) {
  return String(n || '').replace(/\s+/g, ' ').trim().slice(0, MAX_PL_NAME);
}

function guessMediaName(url) {
  let n = '';
  try { n = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch (e) {}
  return plCleanName(n) || 'Video';
}

function plValidateItems(items) {
  const out = [];
  if (!Array.isArray(items)) return out;
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const url = safeMediaUrl(it.url);
    if (!url) continue;
    out.push({ url, name: plCleanName(it.name) || guessMediaName(url) });
    if (out.length >= MAX_PLAYLIST) break;
  }
  return out;
}

function plAddRemote(items) {
  const valid = plValidateItems(items);
  let added = 0;
  for (const it of valid) {
    if (state.playlist.length >= MAX_PLAYLIST) { toast('Playlist is full (50 max)'); break; }
    state.playlist.push(it);
    added++;
  }
  if (added) {
    const cur = state.mediaUrl;
    if (state.plIndex < 0 && cur) {
      const idx = state.playlist.findIndex(x => x.url === cur);
      if (idx >= 0) state.plIndex = idx;
    }
    renderPlaylistUI();
  }
  return added;
}

function plAddLocal(items) {
  if (!state.secure) { toast('Wait for the encrypted connection'); return false; }
  const before = state.playlist.length;
  const added = plAddRemote(items);
  if (!added) return false;
  send({ t: 'pl-add', items: state.playlist.slice(before, before + added) });
  addSystem('📋 ' + added + ' video' + (added > 1 ? 's' : '') + ' added to the playlist');
  return true;
}

function plRemoveLocal(i) {
  if (!(i >= 0) || i >= state.playlist.length) return;
  state.playlist.splice(i, 1);
  if (state.plIndex === i) state.plIndex = -1;
  else if (state.plIndex > i) state.plIndex--;
  renderPlaylistUI();
  send({ t: 'pl-remove', i });
}

function plClearLocal() {
  state.playlist = [];
  state.plIndex = -1;
  renderPlaylistUI();
  send({ t: 'pl-clear' });
  addSystem('📋 Playlist cleared');
}

function plJumpLocal(i) {
  const it = state.playlist[i];
  if (!it) return;
  if (!state.secure) { toast('Wait for the encrypted connection'); return; }
  state.localQueue = [];       // an explicit playlist jump ends the local queue
  state.plIndex = i;
  renderPlaylistUI();
  state.mediaUrl = it.url;
  state.localFile = null;
  state.mediaName = it.name;
  setMedia(it.url, it.name);
  send({ t: 'pl-jump', i });
  send({ t: 'media-url', url: it.url, name: it.name });
}

/* auto-advance when a video ends (2s guard against repeat events) */
let plLastAdvance = 0;
function plAdvanceMaybe() {
  if (Date.now() - plLastAdvance < 2000) return;
  if (state.plIndex < 0 || state.plIndex >= state.playlist.length - 1) return;
  const next = state.plIndex + 1;
  plLastAdvance = Date.now();
  addSystem('⏭️ Next: ' + state.playlist[next].name);
  plJumpLocal(next);
}

video.addEventListener('ended', () => {
  if (state.isYT) return;
  if (state.localQueue.length && playNextLocal()) return;   // files picked together
  plAdvanceMaybe();
});

/* ----- playlist sheet ----- */
let plSheetOpen = false;

function renderPlaylistUI() {
  if (plSheetOpen) renderPlaylistSheet();
}

function openPlaylistSheet() {
  haptic(8);
  renderPlaylistSheet();
}

function renderPlaylistSheet() {
  plSheetOpen = true;
  const n = state.playlist.length;
  const q = state.localQueue;
  const rows = state.playlist.map((it, i) => `
    <div class="pl-row${i === state.plIndex ? ' now' : ''}" data-i="${i}">
      <div class="pl-num">${i === state.plIndex ? '▶' : (i + 1)}</div>
      <div class="pl-name">${escHtml(it.name)}</div>
      <button class="pl-del" data-del="${i}" aria-label="Remove from playlist">✕</button>
    </div>`).join('');
  const localRows = q.map((f, i) => `
    <div class="pl-row local" data-local="${i}">
      <div class="pl-num">📁</div>
      <div class="pl-name">${escHtml(String(f.name || 'movie'))}</div>
      <button class="pl-del" data-ldel="${i}" aria-label="Remove from this device's queue">✕</button>
    </div>`).join('');
  const intro = n
    ? n + ' video' + (n > 1 ? 's' : '') + ' — tap one to play it for both of you. Videos play one after another automatically.'
    : (q.length
      ? 'These files play one after another automatically — your partner gets each one when it starts.'
      : 'Nothing queued yet. Paste a link (a YouTube playlist works too), or choose several files at once.');
  openSheet(`
    <h3>Playlist</h3>
    <p>${intro}</p>
    <div class="pl-list">${rows}</div>
    ${q.length ? `<div class="pl-sub">Next from this device (${q.length})</div><div class="pl-list">${localRows}</div>` : ''}
    ${n ? '<button class="btn ghost" id="pl-clear">Clear playlist</button>' : ''}
  `);
  sheetBody.querySelectorAll('.pl-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.pl-del')) return;
      if (row.dataset.local !== undefined) return;   // local files play by themselves
      closeSheet();
      plJumpLocal(Number(row.dataset.i));
    });
  });
  sheetBody.querySelectorAll('.pl-del').forEach(b => {
    b.addEventListener('click', () => {
      if (b.dataset.ldel !== undefined) {
        state.localQueue.splice(Number(b.dataset.ldel), 1);
        renderPlaylistSheet();
        return;
      }
      plRemoveLocal(Number(b.dataset.del));
    });
  });
  const clr = $('#pl-clear');
  if (clr) clr.addEventListener('click', () => plClearLocal());
}

/* =========================================================
   LINK FINDER - paste any page, find the videos on it.
   Direct fetch first; a public CORS proxy as fallback
   (browsers cannot read other sites' HTML without one).
   ========================================================= */
const MEDIA_EXT_RE = /\.(mp4|webm|ogv|ogg|mov|m4v|mkv|m3u8|mpd)(?:[?#]|$)/i;

function classifyUrl(url) {
  if (parseYouTube(url)) return 'yt';
  if (parseYouTubePlaylist(url)) return 'ytlist';   // …?list=PL… → expand the list
  if (MEDIA_EXT_RE.test(url)) return 'file';
  return 'page';
}

/* ---------- YouTube playlists ----------
   A playlist link carries only a list id, so there is no single video to play.
   We read the public playlist page (it ships the first ~100 entries) and fall
   back to the playlist RSS feed, then offer every video as a queueable item. */
function parseYouTubePlaylist(url) {
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  if (!/(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/i.test(u.hostname)) return null;
  const id = u.searchParams.get('list') || '';
  return /^[A-Za-z0-9_-]{10,60}$/.test(id) ? id : null;
}

const ytWatchUrl = id => 'https://www.youtube.com/watch?v=' + id;

function ytUnescape(s) {
  return String(s || '')
    .replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\"/g, '"').replace(/\\\//g, '/')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function ytAddItem(out, seen, id, title) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(id) || seen.has(id) || out.length >= MAX_PLAYLIST) return;
  seen.add(id);
  out.push({ url: ytWatchUrl(id), name: ytUnescape(title).slice(0, MAX_MEDIA_NAME) || 'YouTube video' });
}

function extractYouTubePlaylist(html) {
  const out = [];
  const seen = new Set();
  // classic playlist markup: {"videoId":"ID", … ,"title":{"runs":[{"text":"TITLE"
  const re = /"playlistVideoRenderer":\{"videoId":"([A-Za-z0-9_-]{11})"[\s\S]{0,2000}?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(html)) && out.length < MAX_PLAYLIST) ytAddItem(out, seen, m[1], m[2]);
  if (out.length) return out;

  // 2025+ markup: one lockupViewModel block per row (contentId + metadata title)
  const blocks = html.split('"lockupViewModel":{').slice(1);
  for (const block of blocks) {
    const idm = /"contentId":"([A-Za-z0-9_-]{11})"/.exec(block) ||
                /i\.ytimg\.com\/vi\/([A-Za-z0-9_-]{11})\//.exec(block);
    if (!idm) continue;
    const tm = /"lockupMetadataViewModel":\{"title":\{"content":"((?:[^"\\]|\\.)*)"/.exec(block);
    ytAddItem(out, seen, idm[1], tm ? tm[1] : '');
    if (out.length >= MAX_PLAYLIST) break;
  }
  if (out.length) return out;

  // last resort: ids only, no titles
  const idRe = /"(?:videoId|contentId)":"([A-Za-z0-9_-]{11})"/g;
  while ((m = idRe.exec(html)) && out.length < MAX_PLAYLIST) ytAddItem(out, seen, m[1], '');
  return out;
}

function extractYouTubeJina(md) {
  const out = [];
  const seen = new Set();
  // "### [Video title](https://www.youtube.com/watch?v=ID&list=…&index=1)"
  const re = /###\s*\[([^\]]+)\]\(https?:\/\/(?:www\.|m\.)?youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})/g;
  let m;
  while ((m = re.exec(md)) && out.length < MAX_PLAYLIST) ytAddItem(out, seen, m[2], m[1]);
  return out;
}

/* r.jina.ai renders the playlist page to markdown *and* sends CORS headers,
   which is the only reader that survives YouTube's huge HTML. */
async function fetchYouTubeMarkdown(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    const res = await fetch('https://r.jina.ai/' + url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const text = await res.text();
    return text && text.length > 100 ? text : null;
  } catch (e) { return null; }
}

function extractYouTubeFeed(xml) {
  const out = [];
  const seen = new Set();
  const re = /<yt:videoId>\s*([A-Za-z0-9_-]{11})\s*<\/yt:videoId>[\s\S]*?<media:title>([\s\S]*?)<\/media:title>/g;
  let m;
  while ((m = re.exec(xml)) && out.length < MAX_PLAYLIST) ytAddItem(out, seen, m[1], m[2]);
  return out;
}

async function fetchYouTubePlaylist(id) {
  const enc = encodeURIComponent(id);
  const pageUrl = 'https://www.youtube.com/playlist?list=' + enc;

  // 1. reader proxy → markdown with titles, usually the first ~100 videos
  const md = await fetchYouTubeMarkdown(pageUrl);
  if (md) {
    const fromMd = extractYouTubeJina(md);
    if (fromMd.length) return fromMd;
  }

  // 2. the playlist page itself, through a CORS proxy
  const html = await fetchPageHtml(pageUrl);
  const fromPage = html ? extractYouTubePlaylist(html) : [];
  if (fromPage.length) return fromPage;

  // 3. playlist RSS: tiny and reliable, but only the 15 newest videos
  const feed = await fetchPageHtml('https://www.youtube.com/feeds/videos.xml?playlist_id=' + enc);
  return feed ? extractYouTubeFeed(feed) : [];
}

const CRAWL_PROXIES = [
  u => u,
  u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u),
];

let crawling = false;

async function fetchPageHtml(url) {
  for (const wrap of CRAWL_PROXIES) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(wrap(url), { signal: ctrl.signal, redirect: 'follow' });
      clearTimeout(timer);
      if (!res.ok) continue;
      const text = await res.text();
      if (text && text.length > 60) return text;
    } catch (e) { /* try the next route */ }
  }
  return null;
}

function extractVideos(html, pageUrl) {
  const found = new Map();
  const add = raw => {
    if (!raw || typeof raw !== 'string') return;
    const u = raw.replace(/&amp;/g, '&').trim();
    if (!u || u.length > MAX_URL) return;
    let abs;
    try { abs = new URL(u, pageUrl).href; } catch (e) { return; }
    if (!/^https?:/i.test(abs) || abs.length > MAX_URL) return;
    if (!MEDIA_EXT_RE.test(abs)) return;
    abs = abs.split('#')[0];
    if (!found.has(abs)) found.set(abs, guessMediaName(abs));
  };

  let doc;
  try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (e) { return []; }

  doc.querySelectorAll('video[src], source[src]').forEach(el => add(el.getAttribute('src')));
  doc.querySelectorAll(
    'meta[property="og:video:secure_url"], meta[property="og:video:url"], meta[property="og:video"], ' +
    'meta[name="twitter:player:stream"]'
  ).forEach(m => add(m.getAttribute('content')));

  doc.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
    try {
      const walk = node => {
        if (!node || typeof node !== 'object' || found.size > 24) return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (typeof node.contentUrl === 'string') add(node.contentUrl);
        if (typeof node.embedUrl === 'string') add(node.embedUrl);
        Object.values(node).forEach(walk);
      };
      walk(JSON.parse(s.textContent));
    } catch (e) {}
  });

  // sweep raw markup for media urls embedded in scripts / JSON
  const re = /https?:\/\/[^\s"'`<>\\)\]]+?\.(?:mp4|webm|ogv|ogg|mov|m4v|mkv|m3u8|mpd)(?:\?[^\s"'`<>\\)\]]*)?/gi;
  let m, guard = 0;
  while ((m = re.exec(html)) && found.size < 24 && guard++ < 5000) add(m[0]);

  return Array.from(found).map(([url, name]) => ({ url, name })).slice(0, 20);
}

function loadDirectLink(url, kind, name) {
  const ytId = kind === 'yt' ? parseYouTube(url) : null;
  state.localQueue = [];   // a pasted link replaces the local file queue
  state.mediaUrl = url;
  state.localFile = null;
  state.mediaName = String(name || (ytId
    ? 'YouTube video'
    : (url.split('/').pop().split('?')[0] || 'Shared movie'))).slice(0, MAX_MEDIA_NAME);
  setMedia(url, state.mediaName);
  send({ t: 'media-url', url, name: state.mediaName });
  closeSheet();
}


/* ----- file transfer ----- */
const CHUNK_SIZE = 16 * 1024;

async function sendFile(file) {
  if (state.sending || !state.secure) return;
  if (!file || file.size <= 0) return;
  if (file.size > MAX_FILE_BYTES) { toast('File is too large to share (max 1.5 GB)'); return; }
  state.sending = true;

  const total = file.size;
  let sent = 0;

  send({
    t: 'file-start',
    name: String(file.name || 'movie').slice(0, MAX_MEDIA_NAME),
    size: total,
    mime: String(file.type || 'video/mp4').slice(0, 80)
  });
  showTransfer('Sending movie…', 0);

  try {
    while (sent < total && state.secure) {
      const slice = file.slice(sent, Math.min(sent + CHUNK_SIZE, total));
      const buf = await slice.arrayBuffer();
      await sendChunk(buf);
      sent += buf.byteLength;
      showTransfer('Sending movie…', sent / total);
      await waitDrain();
    }
    send({ t: 'file-end' });
    showTransfer('Sending movie…', 1);
    setTimeout(hideTransfer, 600);
  } catch (e) {
    toast('Transfer failed');
    hideTransfer();
  }
  state.sending = false;
}

function waitDrain() {
  return new Promise(resolve => {
    const dc = state.conn && state.conn.dataChannel;
    if (!dc) { setTimeout(resolve, 6); return; }
    if (dc.bufferedAmount < 256 * 1024) { resolve(); return; }
    const iv = setInterval(() => {
      const d = state.conn && state.conn.dataChannel;
      if (!d || d.bufferedAmount < 64 * 1024) { clearInterval(iv); resolve(); }
    }, 15);
  });
}

function showTransfer(label, ratio) {
  const t = $('#transfer');
  t.classList.add('show');
  $('#transfer-label').textContent = label;
  $('#transfer-fill').style.width = Math.round(Math.min(1, ratio) * 100) + '%';
  $('#transfer-pct').textContent = Math.round(Math.min(1, ratio) * 100) + '%';
}
function hideTransfer() { $('#transfer').classList.remove('show'); }

/* =========================================================
   VIDEO CONTROLS + SYNC
   ========================================================= */
const ICON_PLAY  = '<path d="M8 5v14l11-7z"/>';
const ICON_PAUSE = '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>';

function updatePlayIcon() {
  const paused = state.isYT
    ? (!ytReady || ytPlayer.getPlayerState() !== 1)
    : video.paused;
  $('#ic-play').innerHTML = paused ? ICON_PLAY : ICON_PAUSE;
}

video.addEventListener('play', () => {
  updatePlayIcon();
  $('#tap-play').classList.remove('show');
  showControls();
  if (Date.now() > state.suppressUntil) send({ t: 'cmd', a: 'play', time: video.currentTime });
});
video.addEventListener('pause', () => {
  updatePlayIcon();
  showControls();
  if (Date.now() > state.suppressUntil) send({ t: 'cmd', a: 'pause', time: video.currentTime });
});
video.addEventListener('seeked', () => {
  if (Date.now() > state.suppressUntil) send({ t: 'cmd', a: 'seek', time: video.currentTime });
});
video.addEventListener('timeupdate', () => { if (!scrubbing) paintScrub(); });
video.addEventListener('loadedmetadata', () => {
  updatePlayIcon();
  timeDur.textContent = fmtDur(video.duration);
  paintScrub();
});

function applyCmd(m) {
  if (!state.mediaLoaded) return;
  state.suppressUntil = Date.now() + 450;
  const t = typeof m.time === 'number' ? m.time : 0;

  if (m.a === 'rate') {
    setRate(m.v, false);
    return;
  }

  if (state.isYT) {
    if (!ytReady) return;
    if (m.a === 'seek' || m.a === 'play' || m.a === 'tick') {
      if (Math.abs(ytPlayer.getCurrentTime() - t) > 0.7) {
        try { ytPlayer.seekTo(t, true); } catch (e) {}
      }
    }
    if (m.a === 'play' || (m.a === 'tick' && m.p)) {
      ytPlayer.playVideo();
    } else if (m.a === 'pause' || (m.a === 'tick' && !m.p)) {
      ytPlayer.pauseVideo();
    }
    return;
  }

  if (m.a === 'seek' || m.a === 'play') {
    if (Math.abs(video.currentTime - t) > 0.35 && video.readyState > 0) {
      try { video.currentTime = t; } catch (e) {}
    }
  }

  if (m.a === 'play') {
    video.play().catch(() => { $('#tap-play').classList.add('show'); });
  } else if (m.a === 'pause') {
    video.pause();
  } else if (m.a === 'tick') {
    if (Math.abs(video.currentTime - t) > 0.8 && video.readyState > 0) {
      try { video.currentTime = t; } catch (e) {}
    }
    if (m.p && video.paused) video.play().catch(() => {});
    if (!m.p && !video.paused) video.pause();
  }
}

// host is the clock authority
setInterval(() => {
  if (state.role !== 'host' || !state.connected || !state.mediaLoaded) return;
  if (state.isYT) {
    if (ytReady && ytPlayer.getPlayerState() === 1) {
      send({ t: 'cmd', a: 'tick', time: ytPlayer.getCurrentTime(), p: true });
    }
  } else if (!video.paused) {
    send({ t: 'cmd', a: 'tick', time: video.currentTime, p: true });
  }
}, 4000);

// smooth progress for YouTube (no timeupdate event)
setInterval(() => {
  if (state.isYT && ytReady && state.mediaLoaded && !scrubbing) {
    paintScrub();
    updatePlayIcon();
    // YouTube reports "ended" (state 0) with no DOM event we can catch
    if (ytPlayer.getPlayerState() === 0 && Date.now() > state.suppressUntil) plAdvanceMaybe();
  }
}, 300);

/* ----- scrubber ----- */
let scrubbing = false;

function paintScrub(ratioOverride) {
  const dur = state.isYT
    ? (ytReady ? ytPlayer.getDuration() : 0)
    : (video.duration || 0);
  const cur = state.isYT
    ? (ytReady ? ytPlayer.getCurrentTime() : 0)
    : video.currentTime;
  const ratio = ratioOverride != null
    ? ratioOverride
    : (dur ? Math.min(1, cur / dur) : 0);
  scrubFill.style.width = (ratio * 100) + '%';
  scrubKnob.style.left = (ratio * 100) + '%';
  timeCur.textContent = fmtDur(ratioOverride != null ? ratioOverride * dur : cur);
  if (state.isYT && dur) timeDur.textContent = fmtDur(dur);
}
function resetScrub() {
  scrubFill.style.width = '0%';
  scrubKnob.style.left = '0%';
  timeCur.textContent = '0:00';
  timeDur.textContent = '0:00';
}

function ratioFromEvent(e) {
  const r = scrub.getBoundingClientRect();
  return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
}

scrub.addEventListener('pointerdown', e => {
  if (!state.mediaLoaded) return;
  scrubbing = true;
  scrub.setPointerCapture(e.pointerId);
  paintScrub(ratioFromEvent(e));
});
scrub.addEventListener('pointermove', e => {
  if (!scrubbing) return;
  paintScrub(ratioFromEvent(e));
});
scrub.addEventListener('pointerup', e => {
  if (!scrubbing) return;
  scrubbing = false;
  const dur = state.isYT
    ? (ytReady ? ytPlayer.getDuration() : 0)
    : (video.duration || 0);
  const t = ratioFromEvent(e) * dur;
  state.suppressUntil = Date.now() + 300;
  if (state.isYT) {
    if (ytReady) { try { ytPlayer.seekTo(t, true); } catch (err) {} }
  } else if (video.readyState > 0) {
    video.currentTime = t;
  }
  send({ t: 'cmd', a: 'seek', time: t });
  paintScrub();
});
scrub.addEventListener('pointercancel', () => { scrubbing = false; });

/* ----- buttons ----- */
function togglePlay() {
  if (!state.mediaLoaded) return;
  haptic(8);
  $('#tap-play').classList.remove('show');
  showControls();
  if (state.isYT) {
    if (!ytReady) return;
    if (ytPlayer.getPlayerState() === 1) ytPlayer.pauseVideo();
    else ytPlayer.playVideo();
    return;
  }
  if (video.paused) video.play().catch(() => {}); else video.pause();
}
$('#btn-play').addEventListener('click', togglePlay);
$('#btn-plist').addEventListener('click', openPlaylistSheet);
$('#tap-play').addEventListener('click', () => {
  $('#tap-play').classList.remove('show');
  if (state.isYT) {
    if (ytReady) ytPlayer.playVideo();
    return;
  }
  video.play().catch(() => {});
});
function isFakeLandscape() { return videoWrap.classList.contains('fake-landscape'); }
function applyFakeLandscape() {
  videoWrap.classList.add('fake-landscape');
  document.body.classList.add('fs-landscape');
  updateAutoFrame();
  placeSheetForFullscreen();
}
function removeFakeLandscape() {
  videoWrap.classList.remove('fake-landscape');
  document.body.classList.remove('fs-landscape');
  updateAutoFrame();
  placeSheetForFullscreen();
}

async function enterFullscreen() {
  const el = videoWrap;
  try {
    if (el.requestFullscreen) await el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  } catch (e) {}

  let locked = false;
  try {
    if (screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock('landscape');
      locked = true;
    }
  } catch (e) {}

  // Orientation lock not available (iOS Safari etc.) → rotate the stage ourselves
  if (!locked && window.innerHeight > window.innerWidth) applyFakeLandscape();
  showControls(false);
}
function exitFullscreen() {
  removeFakeLandscape();
  try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
  if (!appFullscreenEl()) return;
  try {
    if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  } catch (e) {}
}
$('#btn-full').addEventListener('click', () => {
  haptic(8);
  const isFs = document.fullscreenElement || document.webkitFullscreenElement || isFakeLandscape();
  if (!isFs) enterFullscreen(); else exitFullscreen();
});
$('#btn-fs-exit').addEventListener('click', e => {
  e.stopPropagation();
  haptic(8);
  exitFullscreen();
});
$('#btn-change').addEventListener('click', e => {
  e.stopPropagation();
  haptic(8);
  showControls();
  openMediaChooser();
});
function onFullscreenChange() {
  if (!appFullscreenEl()) {
    removeFakeLandscape();
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
  } else {
    updateAutoFrame();
    placeSheetForFullscreen();
  }
  showControls();
  setTimeout(syncViewport, 250);
}
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);
$('#btn-pick').addEventListener('click', () => { haptic(8); $('#file-input').click(); });

/* Play one local file now and stream it to the partner (same as a single pick). */
function playLocalFile(file) {
  if (!file) return false;
  state.localFile = file;
  state.mediaUrl = null;
  state.mediaName = String(file.name || 'movie').slice(0, MAX_MEDIA_NAME);
  revokeBlob();
  state.blobUrl = URL.createObjectURL(file);
  setMedia(state.blobUrl, file.name);
  if (state.secure) sendFile(file);
  return true;
}

/* Several files at once → the first plays now, the rest wait in a local queue
   and start automatically when the previous one ends (each one is streamed to
   the partner, so you keep watching together). */
$('#file-input').addEventListener('change', e => {
  const files = Array.from(e.target.files || []).filter(f => f && f.size > 0);
  e.target.value = '';
  if (!files.length) return;
  const extra = files.slice(1, 1 + MAX_PLAYLIST);
  state.localQueue = extra;
  playLocalFile(files[0]);
  if (extra.length) {
    addSystem('📁 ' + extra.length + ' more file' + (extra.length > 1 ? 's' : '') +
      ' queued — they play one after another');
    toast(extra.length + ' file' + (extra.length > 1 ? 's' : '') + ' queued');
  }
});

function playNextLocal() {
  const next = state.localQueue.shift();
  if (!next) return false;
  addSystem('🎬 Next file: ' + String(next.name || 'movie').slice(0, MAX_MEDIA_NAME));
  return playLocalFile(next);
}

/* =========================================================
   PLAYER EXTRAS - skip buttons + press-and-hold 2x speed.
   The hold gesture only applies to direct videos (the
   YouTube iframe swallows pointer events anyway). The 2x
   speed is synced to the partner with a `rate` command so
   both sides speed up and return together - no drift.
   ========================================================= */
function setRate(v, broadcast) {
  if (!state.mediaLoaded) return;
  try {
    if (state.isYT) { if (ytReady) ytPlayer.setPlaybackRate(v); }
    else video.playbackRate = v;
  } catch (e) {}
  const pill = $('#speed-pill');
  if (pill) pill.classList.toggle('show', v !== 1);
  if (broadcast) send({ t: 'cmd', a: 'rate', v });
}

/* ----- fast forward / rewind (±10s) ----- */
function skipLocal(sec) {
  if (!state.mediaLoaded || scrubbing) return;
  haptic(8);
  showControls();
  if (state.isYT) {
    if (!ytReady) return;
    const d = ytPlayer.getDuration() || 0;
    const t = Math.max(0, Math.min((ytPlayer.getCurrentTime() || 0) + sec, d || Infinity));
    try { ytPlayer.seekTo(t, true); } catch (e) {}
    state.suppressUntil = Date.now() + 300;
    paintScrub();
    send({ t: 'cmd', a: 'seek', time: t });
    return;
  }
  if (video.readyState < 1) return;
  let t = video.currentTime + sec;
  if (Number.isFinite(video.duration)) t = Math.min(t, video.duration);
  if (t < 0) t = 0;
  try { video.currentTime = t; } catch (e) {}   // `seeked` event syncs the partner
}
$('#btn-rw').addEventListener('click', () => skipLocal(-10));
$('#btn-ff').addEventListener('click', () => skipLocal(10));

/* ----- press & hold the right side of the video = 2x speed ----- */
const HOLD_MS = 380;
let holdTimer = null;
let holdActive = false;
let holdPointer = null;
let holdStart = null;
let holdSwallowUntil = 0;
let tapStart = null;             // { id, x, y, at } of the current press

function holdCancel() {
  if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
  holdPointer = null;
  holdStart = null;
}

/* A long press on a <video> makes mobile browsers offer their own menu
   ("Download video", "Copy video frame"…). The .video-hit layer already keeps
   the press off the media element; this is the belt-and-braces for browsers
   that still fire it on the wrapper. */
videoWrap.addEventListener('contextmenu', e => {
  if (!e.target.closest('.sheet')) e.preventDefault();
});

videoWrap.addEventListener('pointerdown', e => {
  if (holdPointer !== null || holdActive) return;
  if (!state.mediaLoaded || state.isYT || scrubbing) return;
  if (e.target.closest('.controls') || e.target.closest('.empty-stage') ||
      e.target.closest('.tap-play') || e.target.closest('.transfer') ||
      e.target.closest('.fs-exit') || e.target.closest('.ar-btn') ||
      e.target.closest('.sheet') || e.target.closest('.sheet-backdrop') ||
      e.target.closest('.dialog-backdrop')) return;

  // remember the press so pointerup can tell a tap from a hold / drag
  tapStart = { id: e.pointerId, x: e.clientX, y: e.clientY, at: Date.now() };

  const r = videoWrap.getBoundingClientRect();
  if (!r.width) return;
  if ((e.clientX - r.left) / r.width < 0.5) return;    // right half only
  holdPointer = e.pointerId;
  holdStart = { x: e.clientX, y: e.clientY };
  holdTimer = setTimeout(() => {
    holdTimer = null;
    holdActive = true;
    haptic(12);
    setRate(2, true);
  }, HOLD_MS);
});
videoWrap.addEventListener('pointermove', e => {
  // a big move means the user is scrolling / dragging, not holding
  if (holdTimer && holdStart &&
      Math.hypot(e.clientX - holdStart.x, e.clientY - holdStart.y) > 40) holdCancel();
});
videoWrap.addEventListener('pointerup', e => {
  const wasHold = holdActive;
  if (e.pointerId === holdPointer) {
    holdCancel();
    if (wasHold) {
      holdActive = false;
      setRate(1, true);
      holdSwallowUntil = Date.now() + 400;   // the release must not count as a tap
    }
  }
  handleTapEnd(e, wasHold);
});
videoWrap.addEventListener('pointercancel', e => {
  tapStart = null;
  const wasHold = holdActive;
  if (e.pointerId === holdPointer) holdCancel();
  if (wasHold) {
    holdActive = false;
    setRate(1, true);
  }
});

/* ----- tap handling -----
   Taps are detected on pointerup, not on click: mobile browsers delay or skip
   the synthetic click (and a double tap can be swallowed as a zoom gesture),
   which is why double tap did nothing on phones. Pointer events fire for
   touch, pen and mouse alike, immediately. */
function handleTapEnd(e, wasHold) {
  const t = tapStart;
  tapStart = null;
  if (!t || t.id !== e.pointerId) return;
  if (wasHold || !state.mediaLoaded) return;
  if (Date.now() < holdSwallowUntil) return;                     // after a 2× hold
  if (Date.now() - t.at > 450) return;                           // long press
  if (Math.hypot(e.clientX - t.x, e.clientY - t.y) > 14) return; // dragged
  handleVideoTap(e.clientX, e.clientY);
}

/* ----- double tap left / right side = ∓10s ----- */
const DOUBLE_TAP_MS = 350;
let lastTap = null;                 // { side: 'left' | 'right', at: ms }

function showSkipPill(sec, side) {
  const pill = $('#skip-pill');
  if (!pill) return;
  pill.textContent = (sec < 0 ? '⏪ −' : '⏩ +') + Math.abs(sec) + 's';
  pill.classList.toggle('left', side === 'left');
  pill.classList.toggle('right', side === 'right');
  pill.classList.remove('show');
  void pill.offsetWidth;            // restart the fade when tapping again
  pill.classList.add('show');
  clearTimeout(showSkipPill.timer);
  showSkipPill.timer = setTimeout(() => pill.classList.remove('show'), 620);
}

function handleVideoTap(x, y) {
  const r = videoWrap.getBoundingClientRect();
  const ratio = r.width ? (x - r.left) / r.width : 0.5;
  const side = ratio < 0.33 ? 'left' : ratio > 0.67 ? 'right' : null;
  const now = Date.now();

  // double tap on the same side = jump 10s (single tap keeps toggling controls)
  if (side && lastTap && lastTap.side === side && now - lastTap.at < DOUBLE_TAP_MS) {
    lastTap = null;
    const sec = side === 'left' ? -10 : 10;
    showSkipPill(sec, side);
    skipLocal(sec);          // haptics + shows controls + the seek syncs the partner
    return;
  }

  lastTap = side ? { side, at: now } : null;
  toggleControls();
}

/* tap video to show controls, then auto-hide */
let idleTimer;
function showControls(autoHide = true) {
  videoWrap.classList.remove('idle');
  clearTimeout(idleTimer);
  if (autoHide) idleTimer = setTimeout(() => videoWrap.classList.add('idle'), 3000);
}
function hideControls() {
  clearTimeout(idleTimer);
  videoWrap.classList.add('idle');
}
function toggleControls() {
  if (videoWrap.classList.contains('idle')) showControls();
  else hideControls();
}
$('#controls').addEventListener('pointerdown', () => showControls());

/* ----- laptop keyboard shortcuts (Space = play/pause, Left/Right = ±10s) ----- */
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
      (e.target && e.target.isContentEditable)) return;
  if (!inRoomView() || !state.mediaLoaded) return;
  if (sheet.classList.contains('show') || dlgBackdrop.classList.contains('show')) return;

  if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault();
    if (!e.repeat) togglePlay();
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    showSkipPill(10, 'right');
    skipLocal(10);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    showSkipPill(-10, 'left');
    skipLocal(-10);
  }
});

/* =========================================================
   CHAT
   ========================================================= */
const TICK1 = '<svg class="tick" viewBox="0 0 18 12"><path d="M1.5 6.5l3.6 3.6L12 3"/></svg>';
const TICK2 = '<svg class="tick" viewBox="0 0 22 12"><path d="M1.5 6.5l3.6 3.6L12 3"/><path d="M8 9.4l1.2 1.2L20.5 3"/></svg>';

function addSystem(text) {
  const el = document.createElement('div');
  el.className = 'sys';
  el.textContent = text;
  chat.appendChild(el);
  scrollChat(true);
}

function addMessage(m) {
  if (!m.reactions) m.reactions = [];
  state.messages.push(m);

  // keep memory bounded during long sessions
  if (state.messages.length > 800) {
    const old = state.messages.shift();
    const oldEl = chat.querySelector('.msg[data-id="' + old.id + '"]');
    if (oldEl) oldEl.remove();
  }

  const el = document.createElement('div');
  el.className = 'msg ' + (m.from === 'me' ? 'me' : 'them');
  el.dataset.id = m.id;

  const swipeIc = document.createElement('div');
  swipeIc.className = 'swipe-ic';
  swipeIc.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h9a7 7 0 010 14h-3"/></svg>';
  el.appendChild(swipeIc);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (m.reply) {
    const q = document.createElement('div');
    q.className = 'quote';
    const qn = document.createElement('div');
    qn.className = 'quote-name';
    qn.textContent = m.reply.name || 'Message';
    const qt = document.createElement('div');
    qt.className = 'quote-text';
    qt.textContent = m.reply.text || '';
    q.appendChild(qn);
    q.appendChild(qt);
    bubble.appendChild(q);
  }

  const text = document.createElement('span');
  text.className = 'msg-text';
  text.textContent = m.text;

  const meta = document.createElement('div');
  meta.className = 'meta';

  const time = document.createElement('span');
  time.textContent = fmtClock(m.ts);

  meta.appendChild(time);

  if (m.from === 'me') {
    const ticks = document.createElement('span');
    ticks.className = 'ticks' + (m.status === 'read' ? ' read' : '');
    ticks.dataset.ticks = m.id;
    ticks.innerHTML = m.status === 'sent' ? TICK1 : TICK2;
    meta.appendChild(ticks);
  }

  bubble.appendChild(text);
  bubble.appendChild(meta);
  el.appendChild(bubble);
  chat.appendChild(el);

  attachGestures(el, bubble, m);
  if (m.reactions.length) renderReactions(m);

  scrollChat(false);
}

function paintTicks(m) {
  const el = chat.querySelector(`[data-ticks="${m.id}"]`);
  if (!el) return;
  el.innerHTML = m.status === 'sent' ? TICK1 : TICK2;
  el.classList.toggle('read', m.status === 'read');
}

function scrollChat(force) {
  const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 140;
  if (force || nearBottom) {
    requestAnimationFrame(() => {
      chat.scrollTo({ top: chat.scrollHeight, behavior: 'smooth' });
    });
  }
}

/* ---------- swipe-to-reply + double-tap-to-react ---------- */
const QUICK_REACTIONS = ['❤️','😂','😮','😢','👍','🔥'];
const SWIPE_TRIGGER = 62;

let gesture = null;
let reactPicker = null;

function attachGestures(el, bubble, m) {
  el.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.reactions')) return;
    const elRect = el.getBoundingClientRect();
    const bRect = bubble.getBoundingClientRect();
    gesture = {
      el, bubble, m, id: e.pointerId,
      startX: e.clientX, startY: e.clientY,
      dx: 0, decided: false, horizontal: false, moved: false
    };
    const ic = el.querySelector('.swipe-ic');
    ic.style.left = Math.max(0, bRect.left - elRect.left - 32) + 'px';
  });
}

function resetSwipeVisual(g) {
  const ic = g.el.querySelector('.swipe-ic');
  g.el.classList.remove('swiping');
  g.bubble.style.transform = '';
  if (ic) {
    ic.style.opacity = 0;
    ic.style.transform = 'translateY(-50%) scale(.6)';
    ic.classList.remove('ready');
  }
}

document.addEventListener('pointermove', e => {
  if (!gesture || e.pointerId !== gesture.id) return;
  const dx = e.clientX - gesture.startX;
  const dy = e.clientY - gesture.startY;

  if (!gesture.decided) {
    if (Math.abs(dx) < 7 && Math.abs(dy) < 7) return;
    gesture.decided = true;
    gesture.horizontal = Math.abs(dx) > Math.abs(dy) * 1.2;
    if (!gesture.horizontal) { gesture = null; return; }
    gesture.el.classList.add('swiping');
  }

  gesture.moved = true;
  gesture.dx = Math.max(0, Math.min(96, dx));
  gesture.bubble.style.transform = 'translateX(' + gesture.dx + 'px)';

  const ratio = Math.min(1, gesture.dx / SWIPE_TRIGGER);
  const ic = gesture.el.querySelector('.swipe-ic');
  ic.style.opacity = ratio;
  ic.style.transform = 'translateY(-50%) scale(' + (0.6 + 0.4 * ratio) + ')';
  ic.classList.toggle('ready', ratio >= 1);
}, { passive: true });

document.addEventListener('pointerup', e => {
  if (!gesture || e.pointerId !== gesture.id) return;
  const g = gesture;
  gesture = null;
  resetSwipeVisual(g);

  if (g.horizontal && g.dx >= SWIPE_TRIGGER) { setReply(g.m); return; }
  if (!g.moved) handleTap(g.el, g.m);
}, { passive: true });

document.addEventListener('pointercancel', () => {
  if (!gesture) return;
  const g = gesture;
  gesture = null;
  resetSwipeVisual(g);
});

function handleTap(el, m) {
  const now = Date.now();
  if (el._lastTap && now - el._lastTap < 320) {
    el._lastTap = 0;
    showReactionPicker(el, m);
  } else {
    el._lastTap = now;
  }
}

function showReactionPicker(el, m) {
  closeReactionPicker();
  haptic(12);

  const picker = document.createElement('div');
  picker.className = 'react-picker';
  const mine = reactionOf(m, 'me');
  QUICK_REACTIONS.forEach(emoji => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = emoji;
    if (mine && mine.emoji === emoji) b.classList.add('is-on');
    b.addEventListener('pointerdown', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      closeReactionPicker();
      toggleReaction(m, emoji);
    });
    picker.appendChild(b);
  });

  document.body.appendChild(picker);
  reactPicker = picker;

  const r = el.getBoundingClientRect();
  const pr = picker.getBoundingClientRect();
  let left = r.left + r.width / 2 - pr.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - pr.width - 8));
  let top = r.top - pr.height - 8;
  if (top < 8) top = r.bottom + 8;
  picker.style.left = left + 'px';
  picker.style.top = top + 'px';

  setTimeout(() => document.addEventListener('pointerdown', onPickerOutside, true), 0);
}

function onPickerOutside(e) {
  if (reactPicker && !reactPicker.contains(e.target)) closeReactionPicker();
}

function closeReactionPicker() {
  if (reactPicker) { reactPicker.remove(); reactPicker = null; }
  document.removeEventListener('pointerdown', onPickerOutside, true);
}

/* One reaction per person, per message. Tapping the same emoji again removes
   it; picking a different one replaces the previous one. */
function reactionOf(m, from) {
  return (m.reactions || []).find(r => r && r.from === from) || null;
}

function setReaction(m, emoji, from, forceRemove) {
  if (!m.reactions) m.reactions = [];
  const idx = m.reactions.findIndex(r => r && r.from === from);
  const same = idx >= 0 && m.reactions[idx].emoji === emoji;
  if (forceRemove || same) {
    if (idx >= 0) m.reactions.splice(idx, 1);
    renderReactions(m);
    return false;
  }
  if (idx >= 0) m.reactions[idx] = { from, emoji };
  else m.reactions.push({ from, emoji });
  renderReactions(m);
  return true;
}

function toggleReaction(m, emoji) {
  const added = setReaction(m, emoji, 'me');
  if (added) spawnFloatingEmoji(emoji, { count: 3 });
  haptic(added ? 10 : 6);
  send({ t: 'react', id: m.id, emoji, remove: !added });
}

function renderReactions(m) {
  const el = chat.querySelector('.msg[data-id="' + m.id + '"]');
  if (!el) return;
  let box = el.querySelector('.reactions');
  if (!m.reactions.length) {
    if (box) box.remove();
    el.classList.remove('has-reactions');
    return;
  }
  if (!box) {
    box = document.createElement('div');
    box.className = 'reactions';
    el.appendChild(box);
  }
  box.textContent = m.reactions.map(r => (typeof r === 'string' ? r : r.emoji)).join('');
  el.classList.add('has-reactions');
  scrollChat(false);
}

/* ---------- reply context ---------- */
function setReply(m) {
  state.replyTo = {
    id: m.id,
    text: m.text,
    name: m.from === 'me' ? (state.username || 'You') : (state.partnerName || 'Partner')
  };
  $('#reply-bar-name').textContent = 'Replying to ' + state.replyTo.name;
  $('#reply-bar-text').textContent = m.text;
  $('#reply-bar').classList.add('show');
  haptic(14);
  try { msgInput.focus({ preventScroll: true }); } catch (e) { msgInput.focus(); }
}

function clearReply() {
  state.replyTo = null;
  const bar = $('#reply-bar');
  if (bar) bar.classList.remove('show');
}

$('#reply-bar-close').addEventListener('click', clearReply);

/* ----- send ----- */
function submitMessage() {
  let text = msgInput.value.trim();
  if (!text) return;
  if (!state.secure) { toast('Still securing the connection…'); return; }
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
  if (!takeToken(txChat)) { toast('Slow down a little'); return; }

  const reply = state.replyTo;
  const m = { id: uid(), text, ts: Date.now(), from: 'me', status: 'sent', reply };
  addMessage(m);
  if (isEmojiOnly(text)) floatEmojiText(text);

  const payload = { t: 'chat', id: m.id, text, ts: m.ts };
  if (reply) payload.reply = reply;
  const ok = send(payload);
  if (ok) { m.status = 'delivered'; paintTicks(m); }

  clearReply();
  msgInput.value = '';
  msgInput.style.height = 'auto';
  sendBtn.disabled = true;
  send({ t: 'typing', on: false });
  haptic(6);

  // keep the keyboard open — never blur the composer after sending
  try { msgInput.focus({ preventScroll: true }); } catch (e) { msgInput.focus(); }
}

// stop the send button from stealing focus (which closes the keyboard)
sendBtn.addEventListener('mousedown', e => e.preventDefault());
sendBtn.addEventListener('click', submitMessage);

msgInput.addEventListener('input', () => {
  sendBtn.disabled = !msgInput.value.trim();
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(96, msgInput.scrollHeight) + 'px';

  const now = Date.now();
  if (now - state.lastTypingSent > 900) {
    state.lastTypingSent = now;
    send({ t: 'typing', on: true });
  }
  clearTimeout(state.typingTimer);
  state.typingTimer = setTimeout(() => send({ t: 'typing', on: false }), 1600);
});

msgInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitMessage();
  }
});

function showRemoteTyping(on) {
  clearTimeout(state.remoteTypingTimer);
  if (on) {
    const label = $('#typing-text');
    if (label) label.textContent = (state.partnerName || 'Partner') + ' is typing';
    typingInd.classList.add('show');
    state.remoteTypingTimer = setTimeout(() => typingInd.classList.remove('show'), 2600);
  } else {
    typingInd.classList.remove('show');
  }
}

/* ----- emoji picker ----- */
const EMOJIS = ['😀','😂','🥰','😍','😎','🤩','😭','🥳','❤️','🔥',
                '✨','🎬','🍿','🎉','👏','💯','👍','👀','💀','🤝'];

function buildEmojiPanel() {
  emojiPanel.innerHTML = '';
  EMOJIS.forEach(e => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = e;
    b.addEventListener('click', () => {
      if (!takeToken(txAnim)) return;
      haptic(5);
      // do NOT insert into the input — just float a burst of emojis (on both sides)
      spawnFloatingEmoji(e, { count: 7 });
      send({ t: 'float', e });
    });
    emojiPanel.appendChild(b);
  });
}
buildEmojiPanel();

$('#btn-emoji').addEventListener('click', () => {
  emojiPanel.classList.toggle('show');
  haptic(6);
});
document.addEventListener('pointerdown', e => {
  if (!emojiPanel.contains(e.target) && e.target.id !== 'btn-emoji') {
    emojiPanel.classList.remove('show');
  }
}, true);

/* =========================================================
   SHEETS
   ========================================================= */
const sheet = $('#sheet');
const sheetBody = $('#sheet-body');
const sheetBackdrop = $('#sheet-backdrop');
const dlgBackdrop = $('#dialog-backdrop');
const toastEl = $('#toast');
const overlayHome = sheet.parentElement || document.body;

function openSheet(html) {
  sheetBody.innerHTML = html;
  placeSheetForFullscreen();
  sheetBackdrop.classList.add('show');
  sheet.classList.add('show');
}
function closeSheet() {
  sheetBackdrop.classList.remove('show');
  sheet.classList.remove('show');
  plSheetOpen = false;
}
/* In player fullscreen the fullscreened .video-wrap is the only thing the
   browser renders - sheets, dialogs and toasts parked outside it would be
   invisible. So while the player is fullscreen (real or fake-landscape)
   those overlays live inside it; everywhere else they live back in .app. */
function placeSheetForFullscreen() {
  const fsEl = appFullscreenEl();
  const host = (fsEl === videoWrap || isFakeLandscape()) ? videoWrap : overlayHome;
  if (sheet.parentElement !== host) {
    host.appendChild(sheetBackdrop);
    host.appendChild(sheet);
    if (dlgBackdrop) host.appendChild(dlgBackdrop);
    if (toastEl) host.appendChild(toastEl);
  }
}
sheetBackdrop.addEventListener('click', closeSheet);

/* ----- link sheet: YouTube, direct files, or any page with videos ----- */
function openLinkSheet() {
  haptic(8);
  openSheet(`
    <h3>Paste a movie link</h3>
    <p>YouTube videos, YouTube <b>playlists</b> and direct video files (.mp4 / .webm / .m3u8…) all work. Paste any <b>page</b> link and Reel looks through it for videos.</p>
    <input type="url" id="url-input" placeholder="https://youtube.com/watch?v=…" autocomplete="off" maxlength="2048">
    <button class="btn" id="url-go">Find video</button>
    <div id="crawl-out"></div>
  `);
  setTimeout(() => $('#url-input').focus(), 350);

  $('#url-go').addEventListener('click', onUrlGo);
}

function onUrlGo() {
  const raw = ($('#url-input').value || '').trim();
  if (raw.length > MAX_URL) { toast('That link is too long'); return; }
  const url = safeMediaUrl(raw);
  if (!url) { toast('Enter a valid http(s) link'); return; }
  const kind = classifyUrl(url);
  if (kind === 'ytlist') { expandYouTubePlaylist(url); return; }
  if (kind !== 'page') { loadDirectLink(url, kind); return; }
  crawlPageLink(url);
}

async function crawlPageLink(url) {
  if (crawling) { toast('Still reading the previous page…'); return; }
  crawling = true;
  const out = $('#crawl-out');
  const go = $('#url-go');
  if (!out || !go) { crawling = false; return; }
  go.disabled = true;
  out.innerHTML = '<div class="crawl-status">🔎 Reading the page…</div>';
  const html = await fetchPageHtml(url);
  crawling = false;
  go.disabled = false;
  if (!out.isConnected) return;                    // sheet was closed meanwhile
  if (!html) {
    out.innerHTML = '<div class="crawl-status">Could not read that site — it may block readers or need a login. Try a direct video link (.mp4 / .m3u8).</div>';
    return;
  }
  const vids = extractVideos(html, url);
  if (!vids.length) {
    out.innerHTML = '<div class="crawl-status">No video files found on that page.</div>';
    return;
  }
  renderCrawlResults(vids);
}

/* Same result list for crawled pages and YouTube playlists: play one now,
   queue one, or queue the whole list. */
function renderCrawlResults(vids, label) {
  const out = $('#crawl-out');
  if (!out || !out.isConnected) return;
  out.innerHTML = `
    <div class="crawl-status">Found ${vids.length} video${vids.length > 1 ? 's' : ''}${label ? ' in this ' + label : ''}</div>
    <div class="crawl-list">${vids.map((v, i) => `
      <div class="crawl-item">
        <div class="crawl-name" title="${escHtml(v.url)}">${escHtml(v.name)}</div>
        <button class="crawl-play" data-play="${i}">Play</button>
        <button class="crawl-add" data-add="${i}">+ Queue</button>
      </div>`).join('')}</div>
    ${vids.length > 1 ? '<button class="btn ghost" id="crawl-all">Add all ' + vids.length + ' to playlist</button>' : ''}`;

  const found = vids;
  out.querySelectorAll('.crawl-play').forEach(b => b.addEventListener('click', () => {
    const i = Number(b.dataset.play);
    loadDirectLink(found[i].url, classifyUrl(found[i].url), found[i].name);
  }));
  out.querySelectorAll('.crawl-add').forEach(b => b.addEventListener('click', () => {
    if (plAddLocal([found[Number(b.dataset.add)]])) {
      b.textContent = 'Queued ✓';
      b.disabled = true;
    }
  }));
  const all = $('#crawl-all');
  if (all) all.addEventListener('click', () => {
    if (plAddLocal(found)) { closeSheet(); setTimeout(openPlaylistSheet, 200); }
  });
}

/* ----- YouTube playlist link → every video in it ----- */
async function expandYouTubePlaylist(url) {
  if (crawling) { toast('Still reading the previous page…'); return; }
  const id = parseYouTubePlaylist(url);
  if (!id) return;
  crawling = true;
  const out = $('#crawl-out');
  const go = $('#url-go');
  if (!out || !go) { crawling = false; return; }
  go.disabled = true;
  out.innerHTML = '<div class="crawl-status">🎬 Reading the playlist…</div>';
  const vids = (await fetchYouTubePlaylist(id)).slice(0, MAX_PLAYLIST);
  crawling = false;
  go.disabled = false;
  if (!out.isConnected) return;
  if (!vids.length) {
    out.innerHTML = '<div class="crawl-status">Could not read that playlist — it may be private or the reader is blocked. Try pasting the video links one by one.</div>';
    return;
  }
  renderCrawlResults(vids, 'playlist');
}
$('#btn-link').addEventListener('click', openLinkSheet);

/* ----- change-movie chooser (works after something is already loaded) ----- */
function openMediaChooser() {
  haptic(8);
  openSheet(`
    <h3>Change the movie</h3>
    <p>Pick a new file or paste a link — your partner switches to it instantly.</p>
    <div class="sheet-menu">
      <button class="btn" id="ch-file">Choose file</button>
      <button class="btn ghost" id="ch-link">Paste a link</button>
    </div>
  `);
  $('#ch-file').addEventListener('click', () => {
    closeSheet();
    setTimeout(() => $('#file-input').click(), 60);
  });
  $('#ch-link').addEventListener('click', () => {
    closeSheet();
    setTimeout(openLinkSheet, 160);
  });
}

/* ---------- app fullscreen (browser tab only) ----------
   In a normal browser tab fullscreen hides the browser's own toolbar, so the
   movie gets the whole screen. Installed PWAs and APK-builder webviews already
   own the window, so the option is not offered there at all. */
function appFullscreenEl() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function inAppShell() {
  if (isStandalone()) return true;
  const mq = window.matchMedia;
  if (mq) {
    // minimal-ui is an installed window; "fullscreen" also matches while the
    // Fullscreen API is active, so only trust it when we are not in fullscreen
    if (mq('(display-mode: minimal-ui)').matches) return true;
    if (!appFullscreenEl() && mq('(display-mode: fullscreen)').matches) return true;
  }
  const ua = navigator.userAgent || '';
  if (/;\s*wv\)/i.test(ua)) return true;                    // Android WebView / APK builders
  if (/Median|GoNative|WebViewGold|Kodika|WebIntoApp|AppMySite/i.test(ua)) return true;
  if (window.cordova || window.Capacitor || window.ReactNativeWebView) return true;
  if (window.median || window.gonative || window.webviewGold) return true;
  return false;
}

function canUseAppFullscreen() {
  const el = document.documentElement;
  return !inAppShell() && !!(el.requestFullscreen || el.webkitRequestFullscreen);
}

async function toggleAppFullscreen() {
  const el = document.documentElement;
  try {
    if (appFullscreenEl()) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      toast('Fullscreen off');
    } else {
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      else { toast('Fullscreen is not available in this browser'); return; }
      toast('Fullscreen on');
    }
  } catch (e) {
    toast('Fullscreen was blocked by the browser');
  }
  setTimeout(syncViewport, 300);
}

/* ----- menu sheet ----- */
$('#btn-menu').addEventListener('click', () => {
  haptic(8);
  const fsOk = canUseAppFullscreen();
  const fsOn = !!appFullscreenEl();
  openSheet(`
    <h3>Room options</h3>
    <p>Code <b style="letter-spacing:1.5px">${formatCode(state.code)}</b></p>
    <p>${state.sas
      ? '🔒 Safety code <b style="letter-spacing:1.5px">' + state.sas.slice(0, 3) + ' ' + state.sas.slice(3) + '</b> — compare it with your partner.'
      : 'Waiting for an encrypted connection…'}</p>
    <div class="sheet-menu">
      <button class="btn ghost" id="m-change">Change movie</button>
      <button class="btn ghost" id="m-plist">Playlist${state.playlist.length ? ' (' + state.playlist.length + ')' : ''}</button>
      ${fsOk ? `<button class="btn ghost" id="m-fs">${fsOn ? 'Exit fullscreen' : 'Fullscreen'}</button>` : ''}
      <button class="btn ghost" id="m-share">Share invite</button>
      <button class="btn dark" id="m-leave">Leave room</button>
    </div>
  `);

  $('#m-change').addEventListener('click', () => {
    closeSheet();
    setTimeout(openMediaChooser, 160);
  });
  $('#m-plist').addEventListener('click', openPlaylistSheet);
  if (fsOk) {
    $('#m-fs').addEventListener('click', () => {
      closeSheet();
      haptic(10);
      toggleAppFullscreen();       // must run inside the tap, before the gesture expires
    });
  }
  $('#m-share').addEventListener('click', async () => {
    const text = `Watch a movie with me on Reel 🎬\nRoom code: ${formatCode(state.code)}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Reel', text }); } catch (e) {}
    } else {
      copyCode();
    }
    closeSheet();
  });
  $('#m-leave').addEventListener('click', async () => {
    closeSheet();
    if (await askLeaveRoom()) leaveRoom();
  });
});

function copyCode() {
  const code = formatCode(state.code);
  const done = () => { toast('Code copied'); haptic(12); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code).then(done).catch(() => fallbackCopy(code, done));
  } else {
    fallbackCopy(code, done);
  }
}
function fallbackCopy(text, cb) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); cb(); } catch (e) { toast('Copy failed'); }
  document.body.removeChild(ta);
}

$('#code-chip').addEventListener('click', () => { haptic(8); copyCode(); });

/* =========================================================
   CONFIRM DIALOG
   ========================================================= */
let dlgResolve = null;

function showDialog(opts = {}) {
  const o = Object.assign({
    icon: '🎬', title: 'Are you sure?', message: '',
    okText: 'Yes', cancelText: 'Cancel', danger: true
  }, opts);

  $('#dialog-icon').textContent = o.icon;
  $('#dialog-title').textContent = o.title;
  $('#dialog-msg').textContent = o.message;

  const okBtn = $('#dialog-ok');
  okBtn.textContent = o.okText;
  okBtn.classList.toggle('danger', o.danger);
  $('#dialog-cancel').textContent = o.cancelText;

  dlgBackdrop.classList.add('show');
  haptic(12);

  return new Promise(resolve => { dlgResolve = resolve; });
}

function closeDialog(result) {
  if (!dlgResolve) return;
  const r = dlgResolve;
  dlgResolve = null;
  dlgBackdrop.classList.remove('show');
  r(result);
}

$('#dialog-ok').addEventListener('click', () => closeDialog(true));
$('#dialog-cancel').addEventListener('click', () => closeDialog(false));
dlgBackdrop.addEventListener('click', e => { if (e.target === dlgBackdrop) closeDialog(false); });

function askLeaveRoom() {
  return showDialog({
    icon: '🚪',
    title: 'Leave the room?',
    message: 'You will be disconnected from ' + (state.partnerName || 'your partner') +
             ' and the movie will stop for both of you.',
    okText: 'Leave',
    cancelText: 'Stay'
  });
}

function askExitApp() {
  return showDialog({
    icon: '👋',
    title: 'Exit Reel?',
    message: 'Are you sure you want to close the app?',
    okText: 'Exit',
    cancelText: 'Stay'
  });
}

/* =========================================================
   BACK-BUTTON GUARD
   ========================================================= */
let allowExit = false;

function pushGuard() {
  if (allowExit) return;
  try { history.pushState({ reelGuard: true }, ''); } catch (e) {}
}

// Arm the guard immediately — the window 'load' event can be delayed by
// fonts/scripts, and until it fires the very first back press would exit
// the app instead of showing the exit dialog.
pushGuard();
window.addEventListener('pageshow', e => { if (e.persisted) pushGuard(); });

function inRoomView() { return !viewRoom.classList.contains('hidden'); }

window.addEventListener('popstate', async () => {
  if (allowExit) return;

  // a dialog is already open → treat the extra back as "stay"
  if (dlgResolve) { closeDialog(false); pushGuard(); return; }

  if (inRoomView()) {
    pushGuard();                       // re-arm before asking
    if (await askLeaveRoom()) leaveRoom();
    return;
  }

  // home / create-room screen → confirm app exit
  if (await askExitApp()) {
    allowExit = true;
    try { window.close(); } catch (e) {}
    setTimeout(() => { try { history.back(); } catch (e) {} }, 80);
    setTimeout(() => { toast('Close the tab to exit'); }, 900);
  } else {
    pushGuard();
  }
});

/* =========================================================
   HOME WIRING
   ========================================================= */
$('#btn-create').addEventListener('click', () => { haptic(12); hostRoom(); });
$('#btn-join').addEventListener('click', () => {
  haptic(12);
  joinRoom($('#code-input').value);
});
$('#btn-leave').addEventListener('click', async () => {
  haptic(10);
  if (await askLeaveRoom()) leaveRoom();
});

const codeInput = $('#code-input');
codeInput.addEventListener('input', () => {
  const raw = cleanCode(codeInput.value);
  codeInput.value = formatCode(raw);
});
codeInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); joinRoom(codeInput.value); }
});

const nameInput = $('#name-input');
try {
  const saved = localStorage.getItem('reel-name');
  if (saved) nameInput.value = saved;
} catch (e) {}
nameInput.addEventListener('input', () => {
  try { localStorage.setItem('reel-name', nameInput.value.trim()); } catch (e) {}
});

/* =========================================================
   PWA - install banner + service worker
   Dismissal is per-visit only: a refresh brings the banner back.
   Once the app is installed the banner never shows (standalone
   mode), and it comes back automatically after an uninstall.
   ========================================================= */
let deferredInstall = null;            // saved beforeinstallprompt event
let installDismissedThisLoad = false;  // ✕ / "Got it" hides it until the next visit

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function showInstallBanner(mode) {   // mode: 'native' | 'ios'
  const b = $('#install-banner');
  if (!b || installDismissedThisLoad || isStandalone()) return;
  // never interrupt someone already inside a room
  if ($('#view-room') && !$('#view-room').classList.contains('hidden')) return;
  if (mode === 'ios') {
    $('#ib-title').textContent = 'Add Reel to your home screen';
    $('#ib-sub').textContent = 'In Safari: tap Share, then Add to Home Screen.';
    $('#ib-install').textContent = 'Got it';
  }
  b.classList.add('show');
}

function hideInstallBanner() {
  const b = $('#install-banner');
  if (b) b.classList.remove('show');
}

function initPWA() {
  const b = $('#install-banner');
  if (b) {
    $('#ib-install').addEventListener('click', () => {
      if (deferredInstall) {
        const p = deferredInstall;
        deferredInstall = null;
        p.prompt();
        p.userChoice.then(choice => {
          if (choice && choice.outcome === 'accepted') {
            hideInstallBanner();           // appinstalled also fires and toasts
          } else {
            installDismissedThisLoad = true;   // they said no - quiet until next visit
            hideInstallBanner();
          }
        }).catch(() => {});
      } else {
        // iOS hint banner: the button is just an acknowledgement
        installDismissedThisLoad = true;
        hideInstallBanner();
      }
    });
    $('#ib-close').addEventListener('click', () => {
      installDismissedThisLoad = true;     // per-visit only; refresh shows it again
      hideInstallBanner();
    });
  }

  // Chromium desktop + Android
  window.addEventListener('beforeinstallprompt', e => {
    if (!e || typeof e.prompt !== 'function') return;
    e.preventDefault();
    deferredInstall = e;
    setTimeout(() => showInstallBanner('native'), 2500);
  });

  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    installDismissedThisLoad = true;       // installed - banner stays gone
    hideInstallBanner();
    toast('Reel installed — look for it on your home screen');
  });

  // iOS Safari never fires beforeinstallprompt, so offer the manual steps
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS && !isStandalone()) {
    setTimeout(() => showInstallBanner('ios'), 3500);
  }

  // offline app shell (localhost is a secure context, so this is allowed)
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
  }
}
initPWA();

/* =========================================================
   MISC
   ========================================================= */
// prevent double-tap zoom on iOS
let lastTouch = 0;
document.addEventListener('touchend', e => {
  const now = Date.now();
  if (now - lastTouch <= 300) e.preventDefault();
  lastTouch = now;
}, { passive: false });

// keep layout stable on resize / keyboard
window.addEventListener('resize', () => {
  syncViewport();
  scrollChat(true);
  // device rotated to real landscape → drop the simulated rotation
  if (isFakeLandscape() && window.innerWidth > window.innerHeight) removeFakeLandscape();
});

/* ---------- mobile keyboard handling ----------
   The app keeps its full size when the keyboard opens — nothing shrinks
   or jumps. We measure how much the keyboard covers and float the composer
   right above it (see body.kb-open rules in the CSS).

   Mobile browsers also *pan* the visual viewport to reveal the focused
   field (visualViewport.offsetTop). The whole app is position:fixed in the
   layout viewport, so that pan used to drag the header and the video off
   the top of the screen. The pan is now published as --vv-top and the app
   re-anchors to the visible band, so only the composer moves. */
const vv = window.visualViewport;

/* isolated so the maths can be checked without a real keyboard */
function readViewport() {
  const innerH = window.innerHeight || 0;
  return {
    innerH,
    vvH: vv ? vv.height : innerH,
    vvTop: vv ? vv.offsetTop : 0
  };
}

function syncViewport() {
  if (!vv) return;
  const { innerH, vvH, vvTop } = readViewport();
  const covered = Math.max(0, innerH - vvH - vvTop);
  const kbOpen = covered > 120;

  document.body.classList.toggle('kb-open', kbOpen);
  document.documentElement.style.setProperty('--kb', kbOpen ? Math.round(covered) + 'px' : '0px');
  // follow the pan only while the keyboard is up — normal scrolling must not move the app
  document.documentElement.style.setProperty(
    '--vv-top', kbOpen && vvTop > 0 ? Math.round(vvTop) + 'px' : '0px'
  );

  if (kbOpen) scrollChat(true);
}

/* coalesce the burst of events fired while the keyboard slides in/out */
let vvFrame = 0;
function queueViewport() {
  if (vvFrame) return;
  vvFrame = requestAnimationFrame(() => { vvFrame = 0; syncViewport(); });
}

if (vv) {
  vv.addEventListener('resize', queueViewport);
  vv.addEventListener('scroll', queueViewport);
}
window.addEventListener('orientationchange', () => setTimeout(syncViewport, 300));

// warn before leaving mid-room
window.addEventListener('beforeunload', e => {
  if (state.connected) { e.preventDefault(); e.returnValue = ''; }
});
window.addEventListener('pagehide', () => { closeVoice(false); });

/* Phone app switching / screen off. The page is frozen while hidden, so the
   retry clock pauses and a liveness probe runs the moment we come back. */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) onAppHidden(); else onAppVisible();
});
window.addEventListener('pageshow', e => { if (e.persisted) onAppVisible(); });
document.addEventListener('freeze', onAppHidden);
document.addEventListener('resume', onAppVisible);

// splash + resume previous session
window.addEventListener('load', () => {
  syncViewport();

  setTimeout(() => {
    const s = $('#splash');
    s.classList.add('gone');
    setTimeout(() => s.remove(), 700);
  }, 900);

  setTimeout(() => { resumeSession(); }, 500);
});
