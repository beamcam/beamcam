# {{REPO_NAME}}

**Phone camera, viewer, 1-to-1 calls and a local recorder, in a web page.
Peer-to-peer WebRTC, self-hosted, no account, no app store, no platform in the middle.**

Open the page on two devices. One films, the other watches. Or you call each other. Video
goes straight from one browser to the other, encrypted end to end. Your server only makes
the introduction.

| App | What it does | Switch |
|-----|--------------|--------|
| **Live** | A phone becomes a camera; any other screen watches it. Hold-to-talk back. Baby monitor, walkie-talkie, second angle, pet cam | `APP_LIVE` |
| **Video call** | 1-to-1, both ways. Camera, screen share or off, switched mid-call | `APP_VIDEOCALL` |
| **Audio call** | 1-to-1 voice. Intercom, calling your parents | `APP_AUDIOCALL` |
| **Editor** | Record the camera or the screen to a WebM file. Nothing is uploaded | `APP_EDITOR` |

Pick the apps you want in `.env`; the others disappear from the home screen.

## Why

Talking to your parents or keeping an eye on a sleeping toddler doesn't require an account
with Meta, Google or Apple. Every modern browser already implements the standards that do it:
[WebRTC](https://www.w3.org/TR/webrtc/) and
[Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/) (W3C), on top of
ICE, DTLS and SRTP (IETF). This repository is the thin layer that wires them together, plus
two small daemons you run yourself.

## Features

* QR-code pairing: scan and you're live, no typing
* Hold-to-talk from viewer to camera, speaker toggle on the camera side
* 1-to-1 video and audio calls; camera ⇄ screen ⇄ off without dropping the call
* Screen shares stay sharp (`contentHint: "detail"`) and are never cropped
* Adaptive bitrate on a 3-minute measured window, or a fixed 0.5-5 Mbps cap
* Brightness, contrast and grayscale applied to the *sent* stream (dark nursery at 500 kbps)
* Screen Wake Lock, so phones don't sleep mid-stream
* Works across networks (STUN, TURN relay with short-lived HMAC credentials), and stays on
  your LAN when both devices are on it
* No framework, no bundler, no CDN, no analytics: vanilla JS, three vendored libraries

## Quick start

```bash
git clone https://github.com/l3dlp/{{REPO_NAME}}.git && cd {{REPO_NAME}}
cp .env.example .env && $EDITOR .env
cd server && ./install.sh && sudo ./install-coturn.sh && sudo ./install-service.sh && cd ..
bash bin/build.sh
# serve dist/ and proxy /peerjs: see config-samples/
```

The full walkthrough, from an empty VPS to calling your parents, is in **[HOWTO.md](HOWTO.md)**.

## How it works

```
 Device A ──WSS (SDP, ICE)──► your server ◄──WSS (SDP, ICE)── Device B
    │                       server.js + coturn                    │
    └──────────────── media, peer-to-peer, DTLS-SRTP ─────────────┘
```

* [Architecture](docs/architecture.md), [configuration](docs/configuration.md),
  [the handshake](docs/handshake.md), [NAT traversal](docs/nat-traversal.md)
* [Push-to-talk](docs/push-to-talk.md), [calls and screen sharing](docs/calls.md),
  [adaptive bitrate](docs/adaptive-bitrate.md), [image filters](docs/image-filters.md),
  [recorder](docs/recorder.md)
* [Privacy model](docs/privacy.md), [self-hosting](docs/self-hosting.md),
  [known limits](docs/limits.md)

## Repository layout

```
.env.example      every setting, documented
bin/build.sh      .env + src/ -> dist/  (the whole build: bash and cp)
src/              app.html, script.js, style.css, assets/ (vendored libs)
server/           server.js (signaling + TURN credentials), install scripts
config-samples/   Caddy and nginx
docs/             how it's built
```

## Browser support

Recent Chrome, Edge, Firefox and Safari, desktop and mobile. Camera access requires HTTPS
(or `localhost`). Screen sharing is desktop-only: mobile browsers don't implement
`getDisplayMedia()`.

## Contributing

Issues and pull requests welcome. Keep it small: no framework, no build tool, no third-party
requests at runtime. Explain *why* in the commit message.

## License

[MIT](LICENSE) © 2026 [L3DLP](https://l3dlp.com) · [github.com/l3dlp](https://github.com/l3dlp)

Vendored libraries keep their own licenses: see [src/assets/LICENSES.md](src/assets/LICENSES.md).
