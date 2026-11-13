# Reel · Watch Together 🎬

> Built and maintained by **samaed-samee** — [github.com/samaed-samee](https://github.com/samaed-samee/)

A tiny, private "watch party in a browser" — share a 12-character room code, pick a movie, and watch it in perfect sync with one other person. No accounts, no installs, no backend of our own.

Everything that travels between the two devices — chat, reactions, playback commands, the movie itself and live voice — is **end-to-end encrypted**. Chat, reactions, sync and files use **AES-GCM-256** with keys that never leave the two browsers; voice uses **WebRTC DTLS-SRTP** with its certificate fingerprints pinned to that same authenticated session.

---

## Table of contents
- [Features](#features)
- [Quick start](#quick-start)
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
| ▶️ **YouTube + links** | Paste a YouTube URL or any direct `.mp4` / `.webm` / `.m3u8` link. |
| 📁 **Send a local file** | Pick a movie from your device; it is streamed to your partner over WebRTC. |
| 💬 **Chat** | Typing indicators, replies, delivery/read ticks, emoji bursts and swipe-to-reply. |
| 🎙️ **Live voice** | Encrypted peer-to-peer voice with one-tap mute, speaking glow and a live waveform. |
| 😍 **Reactions** | Double-tap a message. One reaction per person, tap again to remove it. |
| 🔐 **End-to-end encryption** | Authenticated ECDH + HKDF + AES-GCM-256, plus a safety code to detect a man-in-the-middle. |
| 👥 **Rooms of exactly two** | The host accepts one guest; anyone else is turned away. |
| 📱 **Mobile-first** | Safe-area aware, keyboard-aware composer, fullscreen with landscape lock. |

---

## Quick start

The app uses the Web Crypto API, which browsers only expose in a **secure context** — `https://` or `http://localhost`. Opening `index.html` by double-clicking (`file://`) breaks YouTube playback with *error 153* and disables encryption, so always serve it.

### Windows
Double-click **`start.cmd`**. It starts a local server and opens <http://localhost:8000>.

### macOS / Linux
```bash
python3 -m http.server 8000
```
Then open <http://localhost:8000>.

### Both people
1. One person clicks **Create a room** and shares the 6-word-style code (e.g. `K7QM-2PXA-9WDE`).
2. The other enters the code and clicks **Join room**.
3. Compare the **safety code** shown in the chat (see [Security model](#security-model)).
4. Pick a movie and press play.
5. Tap the **microphone** in the header to start an encrypted voice call. Your partner gets a join prompt; tap the same button (or the mute button in the call bar) to mute.

> The code is the only credential. Share it privately — anyone who has it can take the guest seat.

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
                                └────────── AES-GCM-256 traffic ──────┘
```

1. **Signalling** — both peers connect to the PeerJS cloud broker to exchange connection details. No app data goes through it.
2. **Handshake** — each side generates an ephemeral ECDH P-256 key pair and sends the public key.
3. **Key derivation** — both compute the same shared secret, then run HKDF-SHA256 with the transcript (both public keys + room code) as salt to derive four AES-GCM-256 keys: host→guest, guest→host, and two independent file-chunk keys.
4. **Key confirmation** — each side signs the transcript with HMAC-SHA256 and the peer verifies it in constant time. A mismatch closes the connection immediately.
5. **Transport** — chat, reactions, sync commands and file chunks are encrypted with a fresh random 96-bit IV per frame, sent over the DataChannel, and decrypted only by the other browser.

All app frames are queued through a single async pipeline so encryption never reorders messages, and the receiver processes them in order too.

### Voice calls

Voice is a separate WebRTC media stream, so it is not squeezed through the encrypted data channel:

1. Both people opt in: one taps the microphone, the other accepts the prompt.
2. The **host** places the WebRTC media call; the guest answers with its microphone.
3. Media uses **DTLS-SRTP** and flows directly between the two browsers (STUN only — no TURN relay is configured).
4. The call is bound to the encrypted session: each side sends its local DTLS certificate fingerprint over the AES-GCM data channel and compares it with the fingerprint in the peer's SDP. A mismatch — or a verification that does not complete within 15 seconds — drops the call.
5. Muting disables the local audio track and tells the partner, so the same muted badge shows on both screens.

Because media answers are only created after the data-channel handshake has been authenticated (and the fingerprints are checked afterwards), a malicious signalling relay cannot silently swap itself into the audio path.

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
- connection metadata (timing, IP addresses, data volume),
- SDP / ICE candidates while a voice call is being set up.

It **cannot** read any content and never sees the audio itself — the voice stream is peer-to-peer. It also never learns either user's name or the safety code.

### Man-in-the-middle protection

A malicious relay could try to sit in the middle by performing two separate handshakes. That is detected out-of-band:

- both devices derive a **6-digit safety code** from the handshake transcript,
- the code is shown in the chat and in **Room options → Safety code**,
- a real relayed connection produces **different** codes on the two screens.

Compare the code once, out loud, when you open a room. If it doesn't match, leave immediately.

Voice calls get a second, automatic check. Both browsers send their local **DTLS certificate fingerprint** over the already-authenticated AES-GCM channel and compare it with the fingerprint in the peer's SDP. A relay that rewrites the SDP to insert itself produces a different fingerprint on each leg, so the call is closed with **“Voice security check failed”** instead of carrying audio through the attacker.

### Other hardening

- **Content-Security-Policy** — only `self`, unpkg (PeerJS), Google Fonts and YouTube are allowed; `object-src`, `base-uri` and `form-action` are locked down.
- **Strict referrer policy** for the YouTube embed.
- **Strict input validation** on every field (ids, emoji whitelist, `http(s)` URLs only, `video/*` MIME only, clamped playback times).
- **Tamper resistance** — GCM authentication rejects modified, forged or replayed ciphertext.
- **Fail-closed** — a failed handshake blocks automatic reconnection instead of silently retrying.
- **No `innerHTML` with remote content** — all peer-supplied text is rendered with `textContent`.
- **Microphone is opt-in** — the browser permission prompt appears only when you start or accept a call, and every track is stopped when the call ends, the connection drops or the page is hidden.

---

## Limits & rate limits

| Item | Limit |
|---|---|
| Chat message | 2,000 characters |
| Display name | 20 characters |
| Media URL | 2,048 characters |
| Media / file name | 120 characters |
| Shared file size | 1.5 GB |
| File chunk size | 16 KB (29 bytes encryption overhead each) |
| Chat history kept in memory | 800 messages |
| Handshake timeout | 15 seconds |
| Voice invitation timeout | 30 seconds |
| Voice verification timeout | 15 seconds |
| Voice connection timeout | 25 seconds |
| Incoming frames | 40 burst / 20 per second |
| Incoming reactions & emoji | 6 burst / 0.5 per second |
| Incoming file offers | 3 burst |
| Outgoing chat | 6 burst / 1.5 per second |
| Outgoing emoji bursts | 4 burst / 0.4 per second |

---

## File structure

```
Reel - watch together/
├─ index.html      markup + CSP + meta (no inline scripts)
├─ styles.css      all styling (paper theme, chat, player, sheets)
├─ app.js          all application logic (sync, chat, voice, E2E crypto)
├─ boot.js         tiny Android safe-area bootstrap (runs before CSS)
├─ start.cmd       Windows launcher: local server + opens browser
└─ README.md       this file
```

Load order: `boot.js` (tiny bootstrap in `<head>`), Google Fonts and `peerjs` from unpkg, `styles.css`, then `app.js` at the end of `<body>`. There are **no inline scripts** — the CSP can therefore forbid `'unsafe-inline'` for scripts.

---

## Running it publicly

Any static host works — GitHub Pages, Netlify, Vercel, Cloudflare Pages, an S3 bucket…

**HTTPS is required.** On plain `http://` (other than `localhost`) browsers hide `crypto.subtle`, and Reel refuses to connect rather than sending unencrypted data.

If you change the port in `start.cmd`, update **both** `8000` occurrences (the URL and the Python command).

---

## Troubleshooting

**"Video player configuration error 153" / YouTube won't play**
You opened the page from `file://`. Start the server (`start.cmd` or `python -m http.server`) and use `http://localhost:8000`. YouTube requires an HTTP `Referer` header, which `file://` pages never send.

**"Still securing the connection…" never finishes**
The ECDH handshake could not complete. Usually it means one side is on an old cached version — hard-refresh both (`Ctrl+F5`) — or the browser is not in a secure context. A handshake timeout closes the connection after 15 seconds.

**"Security check failed" / keys don't match**
The two sides could not prove the same shared secret. This is the fail-closed path. Leave the room and rejoin; if two different networks always fail, something is tampering with the connection — stop.

**Room says it is full**
Rooms hold exactly two people. Someone else already took the guest seat; create a new room.

**Voice button says "Wait for the encrypted connection…"**
Voice is only available after the E2E handshake completes and both people are online. If it stays stuck, see the handshake entry above. You can also start the call from **Room options → Start voice call**.

**No microphone prompt / "Microphone permission is needed"**
Grant microphone access in the browser's site settings, then reload. Browsers only expose the microphone on `https://` or `http://localhost`; opening the page from `file://` will not work.

**My partner cannot hear me**
Check that the call bar does not say *You are muted*, and that the browser tab is not muted. On desktop, also check the OS input device and volume mixer.

**Echo or feedback**
Use headphones. Reel asks for echo cancellation, but two open speakers in the same room will still feed back.

**"Voice security check failed"**
The DTLS fingerprint in the call did not match the authenticated session. This is the fail-closed path for a tampered or relayed media path — leave the room and reconnect on a trusted network; do not ignore it.

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

---

## Notes

- This is a client-only app: there is **no account system, database or file storage** anywhere. Reloading a room recreates it.
- Media links must be publicly reachable by your partner; local files are sent peer-to-peer instead.
- On reconnect, a fresh handshake and a new safety code are generated — compare it again.
- Voice calls are direct browser-to-browser. If one network blocks peer-to-peer media (strict corporate NAT/firewall), the call cannot connect; Reel deliberately does not route audio through a third-party TURN server.

---

## Author

**samaed-samee**

- GitHub: <https://github.com/samaed-samee/>

Questions, bug reports and pull requests are welcome on GitHub.

