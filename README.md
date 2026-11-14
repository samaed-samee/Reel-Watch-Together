# Reel · Watch Together 🎬

> Built and maintained by **samaed-samee** — [github.com/samaed-samee](https://github.com/samaed-samee/)

A tiny, private "watch party in a browser" — share a 12-character room code, pick a movie, and watch it in perfect sync with one other person. No accounts, no installs, no backend of our own.

Everything that travels between the two devices — chat, reactions, playback commands, the movie itself and live voice — is **end-to-end encrypted**. Chat, reactions, sync and files use **AES-GCM-256** with keys that never leave the two browsers; voice uses **WebRTC DTLS-SRTP** with its certificate fingerprints pinned to that same authenticated session. PeerJS and hls.js are **vendored locally**, so no third-party script executes in the app's origin.

---

## Table of contents
- [Features](#features)
- [Quick start](#quick-start)
- [Install as an app (PWA)](#install-as-an-app-pwa)
- [Link finder & playlist](#link-finder--playlist)
- [How it works](#how-it-works)
- [Security model](#security-model)
- [Limits & rate limits](#limits--rate-limits)
- [File structure](#file-structure)
- [Running it publicly](#running-it-publicly)
- [Troubleshooting](#troubleshooting)
- [Browser support](#browser-support)
- [Author](#author)

---

## Features

| | |
|---|---|
| 🎥 **Watch in sync** | Play, pause and seek stay locked together. The host is the playback clock. |
| 🔁 **Automatic recovery** | A dropped phone, frozen tab or dead data channel reconnects on its own. Chat, playlist and the current video are kept — there is no “Rejoin” button to tap. |
| ▶️ **YouTube + links** | Paste a YouTube URL, a **YouTube playlist** (every video is listed and queueable in one tap), any direct `.mp4` / `.webm` / `.m3u8` link — or any **web page** link: Reel reads the page and finds the videos on it. |
| ⏩ **Skip & 2× speed** | −10s / +10s buttons next to play, **double tap the left / right third** of the video to jump 10s, and press-and-hold the right half for 2× speed — every jump and speed-up is synced so both people stay together. |
| 📐 **Aspect ratio** | For links and files: **Fit / Fill / Stretch** plus a frame preset (16:9, 4:3, 1:1, 21:9 or *Match video*). A phone-sized vertical clip can fill a portrait frame. Saved on your device; YouTube keeps its own player. |
| 📋 **Playlist** | Queue up to 50 videos in any mix of YouTube / links / HLS streams. Both people add, remove and skip; videos auto-play one after another. |
| 📁 **Send local files** | Pick one movie — or **several at once**: the first plays now, the rest queue and auto-play in turn, each one streamed to your partner over WebRTC. |
| 💬 **Chat** | Typing indicators, replies, delivery/read ticks, emoji bursts and swipe-to-reply. Messages sent near a disconnect are retried automatically, and replays are de-duplicated. |
| 🎙️ **Live voice** | Encrypted peer-to-peer voice with one-tap mute, speaking glow and a live waveform. Audio stays muted until the call's DTLS fingerprint is verified. |
| 😍 **Reactions** | Double-tap a message. One reaction per person, tap again to remove it. |
| 🔐 **End-to-end encryption** | Authenticated ECDH + HKDF + AES-GCM-256, plus a 6-digit safety code to detect a man-in-the-middle. |
| 👥 **Rooms of exactly two** | The host accepts one guest; anyone else is turned away. A returning partner replaces their own stale socket. |
| 📱 **Mobile-first** | Safe-area aware, keyboard-aware composer, fullscreen with landscape lock. Room options also has a browser-only **Fullscreen** toggle that hides the browser toolbar. |
| 📲 **Installable (PWA)** | One-tap install to the home screen: standalone window, custom app icon and an offline app shell. |

---

## Quick start

The app uses the Web Crypto API, which browsers only expose in a **secure context** — `https://` or `http://localhost`. Opening `index.html` by double-clicking (`file://`) breaks YouTube playback with *error 153* and disables encryption, so always serve it.

### Windows
Double-click **`start.cmd`**. It starts a local server bound to `127.0.0.1` and opens <http://localhost:8000>.

### macOS / Linux
```bash
python3 -m http.server 8000 --bind 127.0.0.1
```
Then open <http://localhost:8000>.

### Both people
1. One person clicks **Create a room** and shares the 12-character code (e.g. `K7QM-2PXA-9WDE`).
2. The other enters the code and clicks **Join room**.
3. Compare the **safety code** shown in the chat (see [Security model](#security-model)).
4. Pick a movie and press play.
5. Tap the **microphone** in the header to start an encrypted voice call. Your partner gets a join prompt; tap the same button (or the mute button in the call bar) to mute.

> The code is the only credential. Share it privately — anyone who has it can take the guest seat.

---

## Install as an app (PWA)

Reel is a Progressive Web App. Once installed it opens in its own window with no browser bars, shows the reel icon on your home screen / desktop / taskbar, and its shell (HTML, CSS, JS, vendored libraries, icons) is cached by a service worker so the home screen loads instantly even on a bad connection.

A dark **install banner** with a soft glow slides in from the top of the home screen whenever the app is installable. Dismissing it hides the banner for that visit only — it returns on the next refresh. Once the app is installed the banner stops appearing, and if you uninstall it, the banner comes back on your next visit.

| Platform | How to install |
|---|---|
| **Android** (Chrome, Edge, Samsung Internet) | Tap **Install** on the top banner, or ⋮ menu → *Add to Home screen*. |
| **Windows / macOS** (Chrome, Edge) | Click the **install icon** at the right end of the address bar, or ⋮ → *Cast, save and share* → *Install page as app*. |
| **iOS / iPadOS** (Safari only) | The banner explains it: tap **Share** → **Add to Home Screen**. Apple does not support one-tap install prompts or standalone windows for other browsers. |

How the cache behaves:

- The service worker only handles **`GET`** requests and only caches **app-shell files** (the page, CSS, JS, `vendor/`, icons, manifest). Everything else same-origin is left to the network, so arbitrary responses never end up in the cache.
- It is **network-first**: a fresh copy wins whenever you are online, and the cache is the offline fallback. Page navigations work the same way, falling back to the cached `index.html`.
- PeerJS signalling, fonts, YouTube and media always need the network — the cache only removes the loading wait.
- If you change `app.js`, `styles.css`, `vendor/*` or other app files, bump `VERSION` in `sw.js` (e.g. `reel-shell-v18` → `reel-shell-v19`) **and** the `?v=` values in `index.html`, or returning visitors may keep the old shell.
- The icon files live in `icons/` and can be regenerated any time with `powershell -File icons\make-icons.ps1`.

---

## Link finder & playlist

### Paste any page, get the videos

**Paste a link** accepts four kinds of URL:

| You paste | What happens |
|---|---|
| A YouTube video link | Plays in the built-in YouTube player (unchanged). |
| A **YouTube playlist** link (`…?list=PL…`) | Reel lists every video in the playlist, so you can *Play* one, *+ Queue* one, or **Add all** to the queue in a single tap. |
| A direct video file — `.mp4` `.webm` `.ogv` `.ogg` `.mov` `.m4v` `.mkv` `.m3u8` `.mpd` | Plays directly. `.m3u8` (HLS) uses **hls.js** on browsers without native HLS (Safari plays it natively). |
| Any other web page | Reel **reads the page** and lists every video it can find — then you pick *Play* / *+ Queue* per video, or **Add all** to queue the whole page. |

URLs are validated before anything happens:

- Only `http(s)` links are accepted.
- A link is treated as YouTube only when its **hostname** really is `youtube.com`, `youtube-nocookie.com` or `youtu.be` — a page like `https://evil.example/?u=youtube.com/watch?v=…` is crawled as a page, never played as that video.
- A link **from your partner** may not point at loopback or a private network (`localhost`, `127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `*.local`, `fc00::/7`, `fe80::/10`, `::1`). Media has to be publicly reachable by both people anyway. A link **you paste yourself** is exempt, so local testing still works.

How the page reading works, honestly:

- Browsers cannot read another site's HTML directly (CORS). Reel first tries a plain `fetch`, and if that is blocked it falls back to public CORS proxies (`api.allorigins.win`, `api.codetabs.com`). That means the page URL you crawl is seen by those third-party services, and a flaky proxy day can make crawling fail — pasting a direct video link always works as a fallback.
- For YouTube playlists Reel tries three readers in order: the reader proxy `r.jina.ai` (markdown, usually the first ~100 videos with titles), the playlist page through a CORS proxy, and finally YouTube's playlist RSS feed (always works, but only the 15 newest videos).
- The page is scanned for `<video>` / `<source>` tags, `og:video` / `twitter:player:stream` meta tags, JSON-LD `VideoObject` entries, and `.mp4/.webm/.m3u8/...` URLs inside the page's scripts.
- Sites that need a login or DRM (Netflix, Prime, private Instagram/TikTok) can never work — no browser-side tool can open those.

### Player gestures

| Gesture on a direct video | Result |
|---|---|
| Single tap | Shows / hides the controls. |
| **Double tap the right third** | +10 seconds, synced to your partner (a `⏩ +10s` pill flashes). |
| **Double tap the left third** | −10 seconds, synced (a `⏪ −10s` pill flashes). |
| **Press and hold the right half** | 2× speed while held, then back to 1× — synced. |
| `-10s` / `+10s` buttons | Same jumps from the control bar. |
| Long press anywhere | No browser menu — *Download video* / *Copy video frame* never appear (a transparent tap layer sits over the `<video>`, and `contextmenu` is cancelled). |
| Several files at once | The file picker takes a whole selection; the rest queue as *Next from this device*. |

Gestures are handled on **pointer events** (`pointerdown` / `pointerup`), not `click`, because mobile browsers delay or swallow the synthetic click of a quick double tap. That is why the double tap works on a phone as well as with a mouse.

### Aspect ratio (direct videos only)

The small **frame icon at the top-left of the player** opens *Aspect ratio*. It works for links and files; YouTube plays in its own player, so the button is hidden there and the box stays 16:9.

| Setting | What it changes |
|---|---|
| **Fit** | The picture keeps its shape, with black bars if the box is a different shape (default). |
| **Fill** | The picture is cropped at the edges so it covers the whole box — good on a phone when you want no bars. |
| **Stretch** | The picture is stretched to the box, which can distort it. |
| **Match video** | The *box* copies the clip's own shape (`videoWidth : videoHeight`). A vertical clip is capped in height so it still fits on screen. |
| **16:9 / 4:3 / 1:1 / 21:9** | The *box* takes that shape, whatever the clip is. |

This is a **per-device preference**: it depends on your own screen, so it is not synced and your partner keeps their own. It is stored in `localStorage` (`reel.aspect.v1`) and comes back after a reload; *Reset to default* returns to Fit + 16:9.

### Several files at once

The file picker accepts **multiple files**. The first one starts immediately and the rest wait in *Next from this device* inside the playlist sheet; they start automatically when the previous one ends. Each file is streamed to your partner (AES-GCM-256 chunks) when its turn comes, so you both keep watching together.

### Playlist

- Both people can add, remove and skip; every change syncs through the same **AES-GCM-256** encrypted channel as chat.
- Tap an item to play it for both of you; videos advance automatically when one ends (works for normal files, HLS and YouTube).
- The playlist button lives in the player controls (list icon) and in *Room options*.
- Up to 50 videos, names capped at 120 characters.
- Every playlist change carries a per-connection sequence number. If one is missed (a rate limiter dropped it, or the link blipped), the guest asks the host for a **snapshot** (`pl-ask` → `pl-sync`) and both lists converge again. Duplicate or replayed changes are ignored.
- On reconnect the host's snapshot restores the list and the current item on the other side; the playlist is never wiped by a reconnect.
- Files you picked on this device are listed separately (dashed rows) — they are not part of the synced list, because a local file has no URL to send; the bytes are transferred before each one starts.

---

## How it works

```
                ┌──────────────────────────── PeerJS cloud ────────────────────────────┐
                │  signalling only: SDP / ICE + room id (reel12v1-<code>)              │
                └───────────────▲──────────────────────────────────────▲───────────────┘
                                │                                      │
                    ┌───────────┴───────────┐              ┌───────────┴───────────┐
                    │        Host           │              │        Guest          │
                    │  ECDH keypair (P-256) │              │  ECDH keypair (P-256) │
                    │  HKDF-SHA256 → keys   │              │  HKDF-SHA256 → keys   │
                    └───────────┬───────────┘              └───────────┬───────────┘
                                │         WebRTC DataChannel          │
                                └──────── AES-GCM-256 traffic ────────┘
```

1. **Signalling** — both peers connect to the PeerJS cloud broker to exchange connection details. No app data goes through it.
2. **Handshake** — each side generates an ephemeral ECDH P-256 key pair and sends the public key.
3. **Key derivation** — both compute the same shared secret, then run HKDF-SHA256 with the transcript (both public keys + room code) as salt to derive four AES-GCM-256 keys: host→guest, guest→host, and two independent file-chunk keys.
4. **Key confirmation** — each side signs the transcript with HMAC-SHA256 and the peer verifies it in constant time. A mismatch closes the connection immediately.
5. **Transport** — chat, reactions, sync commands and file chunks are encrypted with a fresh random 96-bit IV per frame, sent over the DataChannel, and decrypted only by the other browser.

All app frames are queued through a single async pipeline so encryption never reorders messages, and the receiver processes them in order too.

**Receive limits.** A peer cannot make the other browser buffer or decrypt without bound, even before the handshake is verified:

- control frames are capped at **192 KB** of base64 and file chunks at **16 KB** of plaintext;
- only **16** control frames and **16** file chunks are held before verification (the old code kept up to 256 chunks);
- the decrypt queue holds at most **64** tasks;
- decrypted control traffic is budgeted at **1.5 MB/s**;
- only **one** incoming file transfer can be active at a time.

### Switching apps / locking the phone

A phone freezes a hidden tab: timers stop, the signalling socket can drop, and the data channel can die without ever firing `close`. Reel is built for that — and reconnects **automatically**, with no prompt and nothing to tap:

- While the page is hidden the reconnect ladder is **paused**, so no attempts are wasted (and the room is never closed just because you checked a message in another app).
- On return (`visibilitychange`, `pageshow`, `resume`) it sends an encrypted **ping** and waits 2.5 s for the pong. A dead channel is dropped immediately instead of being trusted because its state still says `open`.
- The guest then reconnects **at once** — the backoff delays are reset, so the room is back in well under a second on a normal network, without burning retries.
- The host replaces a stale connection instead of answering *room is full*: a returning partner is recognised by a **stable per-room client id**, or by a peer connection that has actually failed, and takes the guest seat back.
- If the other side rebuilt its transport, an incoming `key` frame on an already verified channel restarts the handshake on both ends (throttled so a replay cannot force an endless key reset).
- The retry budget is 40 attempts (about 5 minutes) and it restarts every time you come back. A **failed security check never auto-retries** — that would be the fail-closed case.

What survives a reconnect:

- **Chat history and the playlist are kept.** A reconnect never clears either.
- Any of your messages that were unacknowledged are **re-sent** after the new handshake (up to 20 messages, at most 10 minutes old, with replies intact).
- The receiver **de-duplicates by message id** and acknowledges a replay again, so nothing shows twice and the sender's ticks settle correctly.
- Playlist numbering restarts for the new session, and the host immediately sends a fresh snapshot; the list, the playing item and the playback position are restored.
- A new handshake means a **new safety code** — compare it again after a reconnect.

### Voice calls

Voice is a separate WebRTC media stream, so it is not squeezed through the encrypted data channel:

1. Both people opt in: one taps the microphone, the other accepts the prompt.
2. The **host** places the WebRTC media call; the guest answers with its microphone.
3. Media uses **DTLS-SRTP** and flows directly between the two browsers (STUN only — no TURN relay is configured).
4. The call is bound to the encrypted session. Each side sends its local **DTLS certificate fingerprint set** over the AES-GCM data channel and compares the whole set with the fingerprints in the peer's SDP (an SDP may list several).
5. **Audio is gated in both directions until that check passes**: the microphone track stays disabled and the remote audio element stays muted. Only a verified call becomes audible.
6. The peer's fingerprint must arrive within **4 seconds** of the check starting, and the whole check has a **15-second hard cap**. A mismatch or timeout closes the call with *“Voice security check failed”* / *“Voice verification timed out”* — no audio ever flows through the unverified path.
7. Muting disables the local audio track and tells the partner, so the same muted badge shows on both screens.

Because media answers are only created after the data-channel handshake has been authenticated (and the fingerprints are checked before audio is enabled), a malicious signalling relay cannot silently swap itself into the audio path.

---

## Security model

### What is protected

| Data | Protection |
|---|---|
| Chat messages, replies, typing | AES-GCM-256 |
| Play / pause / seek / tick | AES-GCM-256 |
| Reactions and emoji bursts | AES-GCM-256 |
| Shared links and file names | AES-GCM-256 |
| The movie file itself | AES-GCM-256, separate per-direction chunk keys |
| Live voice audio | WebRTC DTLS-SRTP, certificate fingerprints bound to the authenticated data channel |
| Names / room membership | Encrypted; names are never sent to the relay |

### What the relay can still see

The PeerJS broker needs the **room id** to route the WebRTC connection, so it can see:

- the room code (`reel12v1-<code>`),
- connection metadata: timing, IP addresses, data volume, and an **opaque random client id** used only to recognise a reconnecting partner. That id is stored per room and **rotated when you join a different room**, so it cannot be used to link you across rooms,
- SDP / ICE candidates while a voice call is being set up.

It **cannot** read any content and never sees the audio itself — the voice stream is peer-to-peer. It also never learns either user's name, the safety code, the chat, the playlist or the movie bytes.

### Man-in-the-middle protection

A malicious relay could try to sit in the middle by performing two separate handshakes. That is detected out-of-band:

- both devices derive a **6-digit safety code** from the handshake transcript,
- the code is shown in the chat and in **Room options → Safety code**,
- a real relayed connection produces **different** codes on the two screens.

Compare the code once, out loud, when you open a room. If it doesn't match, leave immediately.

Voice calls get a second, automatic check. Both browsers send their local **DTLS certificate fingerprint set** over the already-authenticated AES-GCM channel and compare it with the fingerprints in the peer's SDP. A relay that rewrites the SDP to insert itself produces a different fingerprint on each leg, so the call is closed with **“Voice security check failed”** instead of carrying audio through the attacker.

### Other hardening

- **No third-party scripts.** PeerJS and hls.js are vendored under `vendor/` and served from this origin. The CSP allows scripts only from `self` plus YouTube's IFrame API. `connect-src`/`media-src` stay broad on purpose because hls.js fetches segments with `fetch()` and pasted links can point anywhere.
- **Hosting headers.** `_headers` adds `X-Frame-Options: DENY`, `frame-ancestors 'none'`, HSTS, `nosniff`, a strict referrer policy, COOP and a `Permissions-Policy` that allows only the microphone (see [Running it publicly](#running-it-publicly)).
- **Strict input validation** on every field (ids, emoji whitelist, `http(s)` URLs only, `video/*` / `audio/*` MIME only, clamped playback times).
- **Peer input hygiene.** Names and chat text have C0/C1 control characters, zero-width characters and bidi overrides stripped, so a peer cannot rewrite the UI around their message. Message timestamps are clamped to ±5 minutes.
- **Peer media URLs** may not point at loopback or private networks; your own pasted links are exempt.
- **Receive-path ceilings** bound frames, chunks, queue depth and decrypt work before and after verification (see [How it works](#how-it-works)).
- **Tamper resistance** — GCM authentication rejects modified, forged or replayed ciphertext; playlist and chat replays are ignored by sequence number / message id.
- **Fail-closed** — a failed handshake closes the connection and blocks automatic reconnection instead of silently retrying.
- **No `innerHTML` with remote content** — all peer-supplied text is rendered with `textContent`.
- **Microphone is opt-in** — the browser permission prompt appears only when you start or accept a call, and every track is stopped when the call ends, the connection drops or the page is unloaded.

---

## Limits & rate limits

| Item | Limit |
|---|---|
| Chat message | 2,000 characters |
| Display name | 20 characters |
| Media URL | 2,048 characters |
| Media / file name | 120 characters |
| Shared file size | 512 MB (the receiver holds it in RAM; one transfer at a time) |
| File chunk size | 16 KB of plaintext (29 bytes encryption overhead each) |
| Playlist size | 50 videos (any mix of YouTube / links / HLS) |
| Chat history kept in memory | 800 messages |
| Handshake timeout | 15 seconds |
| Voice invitation timeout | 30 seconds |
| Voice verification | peer fingerprint within 4 seconds; hard cap 15 seconds |
| Voice connection timeout | 25 seconds |
| Incoming control frames | 40 burst / 20 per second |
| Incoming handshake frames | 8 burst / 2 per second |
| Incoming reactions & emoji | 6 burst / 0.5 per second |
| Incoming file offers | 3 burst / 0.05 per second |
| Incoming playlist frames | 32 burst / 8 per second |
| Incoming liveness probes (`ping`) | 6 burst / 1 per second |
| Reconnect attempts | 40 per run, reset when the app returns |
| Outgoing chat | 6 burst / 1.5 per second |
| Outgoing emoji bursts | 4 burst / 0.4 per second |

Receive-path ceilings:

| Item | Ceiling |
|---|---|
| Control frame | 192 KB of base64 (~144 KB plaintext) |
| File chunk frame | 16 KB plaintext + 29 bytes |
| Frames held before verification | 16 control frames + 16 chunks |
| Decrypt queue depth | 64 tasks |
| Decrypted control traffic | 1.5 MB/s |

---

## File structure

```
Reel - watch together/
├─ index.html      markup + CSP + meta (no inline scripts)
├─ styles.css      all styling (paper theme, chat, player, sheets)
├─ app.js          all application logic (sync, chat, voice, E2E crypto, reconnect, PWA banner, link finder, playlist, player gestures)
├─ boot.js         tiny Android safe-area bootstrap (runs before CSS)
├─ manifest.json   PWA manifest (name, icon sizes, standalone display)
├─ sw.js           service worker (offline app shell, versioned cache)
├─ _headers        security headers for Netlify / Cloudflare Pages–style hosts
├─ vendor/         vendored peerjs 1.5.4 (peer.min.js) and hls.js 1.5.13 (hls.min.js)
├─ icons/          app icons (any + maskable + apple-touch) and the generator script
├─ start.cmd       Windows launcher: local server + opens browser
└─ README.md       this file
```

Load order: `boot.js` (tiny bootstrap in `<head>`), Google Fonts, `vendor/peer.min.js`, `styles.css`, then `app.js` at the end of `<body>`. `vendor/hls.min.js` is loaded from this origin too, but only when an `.m3u8` link is actually played. There are **no inline scripts** — the CSP can therefore forbid `'unsafe-inline'` for scripts.

---

## Running it publicly

Any static host works — GitHub Pages, Netlify, Vercel, Cloudflare Pages, an S3 bucket…

**HTTPS is required.** On plain `http://` (other than `localhost`) browsers hide `crypto.subtle`, and Reel refuses to connect rather than sending unencrypted data.

For hosts that read a `_headers` file (Netlify, Cloudflare Pages), the repository already ships one:

```
/*
  X-Frame-Options: DENY
  Content-Security-Policy: frame-ancestors 'none'
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Cross-Origin-Opener-Policy: same-origin
  Permissions-Policy: microphone=(self), camera=(), geolocation=()
```

If your host uses a different mechanism (Nginx, Apache, a dashboard), copy those header names/values there. The `<meta>` CSP in `index.html` still protects the app when no headers are available, but `frame-ancestors`, HSTS, COOP and `Permissions-Policy` can only be set as real HTTP headers.

`start.cmd` binds the local server to `127.0.0.1`, so it is not exposed on your LAN. If you change the port, update **both** `8000` occurrences (the URL and the Python command).

---

## Troubleshooting

**"Video player configuration error 153" / YouTube won't play**
You opened the page from `file://`. Start the server (`start.cmd` or `python -m http.server`) and use `http://localhost:8000`. YouTube requires an HTTP `Referer` header, which `file://` pages never send.

**"Still securing the connection…" never finishes**
The ECDH handshake could not complete. Usually it means one side is on an old cached version — hard-refresh both (`Ctrl+F5`) — or the browser is not in a secure context. A handshake timeout closes the connection after 15 seconds.

**"Security check failed" / keys don't match**
The two sides could not prove the same shared secret. This is the fail-closed path, and it deliberately stops automatic reconnection. Leave the room and rejoin; if two different networks always fail, something is tampering with the connection — stop.

**Room says it is full**
Rooms hold exactly two people. If it was *your* partner coming back from the background, Reel recognises their per-room client id and replaces the stale connection instead. A real third person is still refused; create a new room.

**The room dropped after I switched apps / locked the screen**
It reconnects automatically — there is no rejoin button. The retry clock pauses while the app is hidden and reconnects immediately when you return (see [Switching apps](#switching-apps--locking-the-phone)). Chat and the playlist are kept. If it still happens, both people should hard-refresh once so no one runs an old cached version.

**A message I sent just before the drop was missing**
It should be re-sent automatically after the new handshake (up to 20 recent unacknowledged messages) and de-duplicated on the other side. If the room had already been closed for more than about 5 minutes, the reconnect budget is exhausted — rejoin the room.

**Voice button says "Wait for the encrypted connection…"**
Voice is only available after the E2E handshake completes and both people are online. If it stays stuck, see the handshake entry above. The call is started from the microphone button in the header.

**No microphone prompt / "Microphone permission is needed"**
Grant microphone access in the browser's site settings, then reload. Browsers only expose the microphone on `https://` or `http://localhost`; opening the page from `file://` will not work.

**My partner cannot hear me**
The call bar is **muted until the DTLS fingerprint check passes** — it should say *Securing voice…* for a moment, then become active. If it never does, see the verification entries below. Also check that the call bar does not say *You are muted*, and that the browser tab is not muted.

**"Voice verification timed out"**
No fingerprint set arrived from your partner within 4 seconds, or the check did not finish within 15 seconds. This is the fail-closed path; the call is closed before any audio plays. Check both connections and try again.

**"Voice security check failed"**
The DTLS fingerprint in the call did not match the authenticated session. This is the fail-closed path for a tampered or relayed media path — leave the room and reconnect on a trusted network; do not ignore it.

**Echo or feedback**
Use headphones. Reel asks for echo cancellation, but two open speakers in the same room will still feed back.

**"File is too large to share"**
The receiver holds the file in RAM while it arrives, so the cap is **512 MB**. Split or compress larger movies, or share a direct link instead.

**"Partner tried to send a file that is too large"**
The other side's file exceeded 512 MB and was refused by the receive guard. Ask them to send a smaller file.

**Page crawl says "Could not read that site"**
The site blocks readers (CORS), the public proxy is down, or the page needs a login. Try again later or paste a direct video link — `.mp4` / `.m3u8` links always work.

**A queued video will not play**
The host site may have removed the file, require cookies you do not have, or geo-block your region. Remove it from the playlist (✕) and try another source.

**Port 8000 is busy**
Change `8000` to e.g. `8080` in both places inside `start.cmd`.

**Partner cannot join**
Check the code (12 characters, dashes optional), and make sure both people can reach the internet — signalling uses the PeerJS cloud broker.

---

## Browser support

| Browser | Status |
|---|---|
| Chrome / Edge (desktop + Android) | ✅ Fully supported |
| Safari (macOS + iOS 15+) | ✅ Supported |
| Firefox | ✅ Supported |
| In-app browsers (Instagram/WhatsApp/FB) | ⚠️ May strip the referrer and block Web Crypto — open in a real browser |

Voice calls need microphone permission and a secure context. Headphones are recommended; echo cancellation is requested but cannot cancel two loudspeakers in the same room.

HLS (`.m3u8`) plays natively in Safari and via hls.js (loaded on demand from `vendor/`) in Chrome, Edge and Firefox.

---

## Notes

- This is a client-only app: there is **no account system, database or file storage** anywhere. Reloading a room recreates it.
- Media links must be publicly reachable by your partner; local files are sent peer-to-peer instead.
- Reconnects are automatic. Each one performs a fresh handshake and generates a **new safety code** — compare it again.
- Chat, reactions and the playlist are kept across a reconnect; the movie position is restored by the host.
- Voice calls are direct browser-to-browser. If one network blocks peer-to-peer media (strict corporate NAT/firewall), the call cannot connect; Reel deliberately does not route audio through a third-party TURN server.

---

## Author

**samaed-samee**

- GitHub: <https://github.com/samaed-samee/>

Questions, bug reports and pull requests are welcome on GitHub.
