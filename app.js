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
const MAX_RECONNECT = 15;

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
}

async function loadYouTube(id, name) {
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
    toast('Code collision — try again');
    setTimeout(leaveRoom, 900);
  }
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
    // Same guest reconnecting → replace the stale connection
    if (incomingId && state.partnerClientId && incomingId === state.partnerClientId) {
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

function wireConn(conn) {
  state.conn = conn;
  state.partnerPeerId = conn.peer || '';
  let opened = false;

  conn.on('open', () => {
    opened = true;
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

    case 'cmd': {
      if (['play', 'pause', 'seek', 'tick'].indexOf(data.a) < 0) break;
      const t = Number(data.time);
      if (!Number.isFinite(t) || t < 0 || t > 7 * 24 * 3600) break;
      applyCmd({ a: data.a, time: t, p: data.p === true });
      break;
    }

    case 'media-url': {
      const url = safeMediaUrl(data.url);
      if (!url) break;
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
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  state.reconnectAttempts = 0;
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
  $('#tap-play').classList.remove('show');
  videoWrap.classList.remove('has-media');
  video.removeAttribute('src');
  try { video.load(); } catch (e) {}
  hideTransfer();
  closeSheet();
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

/* ---------- auto reconnect ---------- */
function scheduleGuestReconnect() {
  if (state.intentionalLeave || state.role !== 'guest' || state.connected) return;
  if (state.securityFailure) return;      // never auto-retry a failed handshake
  if (state.reconnectTimer) return;

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
    state.mediaUrl = url;
    loadYouTube(ytId, name);
    return;
  }

  destroyYouTube();
  $('#tap-play').classList.remove('show');
  hideTransfer();
  try { video.pause(); } catch (e) {}
  resetScrub();
  state.mediaUrl = isBlob ? null : url;
  state.mediaName = String(name || 'Movie').slice(0, MAX_MEDIA_NAME);
  video.src = url;
  video.load();
  state.mediaLoaded = true;
  videoWrap.classList.add('has-media');
  addSystem('🎬 ' + state.mediaName);
  // try autoplay (may be blocked)
  video.play().catch(() => { $('#tap-play').classList.add('show'); });
}

function shareMediaState() {
  if (state.localFile) {
    sendFile(state.localFile);
  } else if (state.mediaUrl) {
    send({ t: 'media-url', url: state.mediaUrl, name: state.mediaName });
  }
  if (state.mediaLoaded) {
    const t = state.isYT ? (ytReady ? ytPlayer.getCurrentTime() : 0) : video.currentTime;
    const paused = state.isYT ? (!ytReady || ytPlayer.getPlayerState() !== 1) : video.paused;
    send({ t: 'cmd', a: 'seek', time: t });
    send({ t: 'cmd', a: paused ? 'pause' : 'play', time: t });
  }
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
$('#btn-play').addEventListener('click', () => {
  if (!state.mediaLoaded) return;
  haptic(8);
  if (state.isYT) {
    if (!ytReady) return;
    if (ytPlayer.getPlayerState() === 1) ytPlayer.pauseVideo();
    else ytPlayer.playVideo();
    return;
  }
  if (video.paused) video.play().catch(() => {}); else video.pause();
});
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
}
function removeFakeLandscape() {
  videoWrap.classList.remove('fake-landscape');
  document.body.classList.remove('fs-landscape');
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
  try {
    if (document.exitFullscreen) document.exitFullscreen();
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
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) {
    removeFakeLandscape();
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
  }
  showControls();
});
document.addEventListener('webkitfullscreenchange', () => {
  if (!document.webkitFullscreenElement) {
    removeFakeLandscape();
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
  }
  showControls();
});
$('#btn-pick').addEventListener('click', () => { haptic(8); $('#file-input').click(); });
$('#file-input').addEventListener('change', e => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  state.localFile = f;
  state.mediaUrl = null;
  revokeBlob();
  state.blobUrl = URL.createObjectURL(f);
  setMedia(state.blobUrl, f.name);
  if (state.secure) sendFile(f);
  e.target.value = '';
});

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
videoWrap.addEventListener('click', e => {
  if (e.target.closest('.controls') || e.target.closest('.empty-stage') || e.target.closest('.tap-play')) return;
  if (!state.mediaLoaded) return;
  toggleControls();
});
$('#controls').addEventListener('pointerdown', () => showControls());

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

function openSheet(html) {
  sheetBody.innerHTML = html;
  sheetBackdrop.classList.add('show');
  sheet.classList.add('show');
}
function closeSheet() {
  sheetBackdrop.classList.remove('show');
  sheet.classList.remove('show');
}
sheetBackdrop.addEventListener('click', closeSheet);

/* ----- link sheet ----- */
function openLinkSheet() {
  haptic(8);
  openSheet(`
    <h3>Paste a movie link</h3>
    <p>YouTube links work, plus direct .mp4 / .webm / .m3u8 files. Your partner receives it automatically.</p>
    <input type="url" id="url-input" placeholder="https://youtube.com/watch?v=…" autocomplete="off" maxlength="2048">
    <button class="btn" id="url-go">Load movie</button>
  `);
  setTimeout(() => $('#url-input').focus(), 350);

  $('#url-go').addEventListener('click', () => {
    const raw = ($('#url-input').value || '').trim();
    if (raw.length > MAX_URL) { toast('That link is too long'); return; }
    const url = safeMediaUrl(raw);
    if (!url) { toast('Enter a valid http(s) link'); return; }
    const ytId = parseYouTube(url);
    state.mediaUrl = url;
    state.localFile = null;
    state.mediaName = String(ytId
      ? 'YouTube video'
      : (url.split('/').pop().split('?')[0] || 'Shared movie')).slice(0, MAX_MEDIA_NAME);
    setMedia(url, state.mediaName);
    send({ t: 'media-url', url, name: state.mediaName });
    closeSheet();
  });
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

/* ----- menu sheet ----- */
$('#btn-menu').addEventListener('click', () => {
  haptic(8);
  openSheet(`
    <h3>Room options</h3>
    <p>Code <b style="letter-spacing:1.5px">${formatCode(state.code)}</b></p>
    <p>${state.sas
      ? '🔒 Safety code <b style="letter-spacing:1.5px">' + state.sas.slice(0, 3) + ' ' + state.sas.slice(3) + '</b> — compare it with your partner.'
      : 'Waiting for an encrypted connection…'}</p>
    <div class="sheet-menu">
      <button class="btn ghost" id="m-voice">${voice.status === 'idle' ? '🎙️ Start voice call' : '🎙️ End voice call'}</button>
      <button class="btn ghost" id="m-change">Change movie</button>
      <button class="btn ghost" id="m-copy">Copy room code</button>
      <button class="btn ghost" id="m-share">Share invite</button>
      <button class="btn dark" id="m-leave">Leave room</button>
    </div>
  `);

  $('#m-voice').addEventListener('click', () => {
    closeSheet();
    if (voice.status === 'idle') startVoiceInvite();
    else closeVoice(true, 'Voice call ended');
  });
  $('#m-change').addEventListener('click', () => {
    closeSheet();
    setTimeout(openMediaChooser, 160);
  });
  $('#m-copy').addEventListener('click', () => {
    copyCode();
    closeSheet();
  });
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
const dlgBackdrop = $('#dialog-backdrop');
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
   or jumps. We only measure how much the keyboard covers and float the
   composer right above it (see body.kb-open rules in the CSS). */
const vv = window.visualViewport;

function syncViewport() {
  if (!vv) return;
  const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  const kbOpen = covered > 120;

  document.body.classList.toggle('kb-open', kbOpen);
  document.documentElement.style.setProperty('--kb', kbOpen ? Math.round(covered) + 'px' : '0px');

  if (kbOpen) scrollChat(true);
}

if (vv) {
  vv.addEventListener('resize', syncViewport);
  vv.addEventListener('scroll', syncViewport);
}
window.addEventListener('orientationchange', () => setTimeout(syncViewport, 300));

// warn before leaving mid-room
window.addEventListener('beforeunload', e => {
  if (state.connected) { e.preventDefault(); e.returnValue = ''; }
});
window.addEventListener('pagehide', () => { closeVoice(false); });

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
