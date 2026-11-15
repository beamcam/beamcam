# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

BeamCam (beamcam.live): a static PWA where a phone becomes a camera that another device watches, plus 1-to-1 video and audio calls and a local recorder. Peer-to-peer WebRTC through PeerJS. The server side is two small daemons: `server/server.js` (PeerJS signaling and TURN credentials) and coturn. Vanilla JS, no framework, no bundler, no CDN, no runtime third-party requests. Keep it that way.

This repo is also the source of a **public open-core repo** (generic, unbranded, called `p2pcam` by default). See "Open-core export" below. It constrains what may appear in the app code.

## Commands

```bash
bash bin/build.sh                     # .env + src/ -> dist/   (the whole build)
node --check src/script.js            # only "lint" available; there are no tests
node --check server/server.js
cd server && npm start                # run signaling server locally (needs TURN_SECRET in .env)
cd dist && python3 -m http.server 8000   # local test; camera needs HTTPS or localhost
bin/export-opencore.sh --force ../opencore p2pcam   # regenerate the public repo
```

There is no test suite or linter. Testing is manual, in two browsers or devices. Hard-reload after a build.

### Live environment: be careful

- **`dist/` is served live by beamcam.live.** Running `bin/build.sh` here deploys. `DIST_DIR` cannot be overridden (only `ENV_FILE` can), so to try a change without deploying, build a copy of the tree somewhere else.
- **The production signaling server runs from this checkout.** systemd `beamcam-peerjs.service` runs `server/server.js` from this `server/` directory. Restarting it, or breaking `server.js` or `.env`, takes down signaling for live users.
- `.env` holds `TURN_SECRET`. Never read it, print it, or copy it anywhere. `.env.example` documents every key.

## Architecture

### Build and config flow
`bin/build.sh` parses `.env` without executing it and writes:
- `dist/config.js`: `window.APP_CONFIG` built from a **whitelist** of public keys (name, signaling host/port/path/secure, STUN URL, app switches). Secrets never go here.
- `dist/index.html`: **the app, served at `/`**. A hand-written `<head>`, then `src/app.html` (a body fragment with `{{APP_NAME}}` / `{{APP_HOME_URL}}` / `{{APP_ABOUT_URL}}` placeholders), then `script.js`.
- A build number `APP_VERSION` (UTC date-time, e.g. `2026.11.15-1921`): in `config.js`, in `dist/version.json`, appended as `?v=` to every asset the app page loads, and shown at the bottom of the home screen. The app polls `version.json` (no-store) on start and when it returns to the foreground, and reloads itself onto `/?v=<new>` when a newer build is out (home screen only). This exists because iOS home-screen apps stay alive and cache for days.
- `dist/manifest.json`. It also copies `script.js`, `style.css`, `site.css`, `sw.js`, `src/assets/*.js` and the `src/pages/` tree as it is: the landing page `about/index.html` (served at `/about/`, so its links use `../`) and the technical page `tech.html`. When `src/pages/` exists, it also writes `dist/app.html`, a stub that redirects old `/app.html#…` links and QR codes to `/`.
- `src/icons/` (optional, branded, not exported to open core) is copied to `dist/icons/`, with `favicon.ico` and `apple-touch-icon.png` also at the root, and the build then adds the icon `<link>`s and manifest icons. Edit the SVG sources (`icon.svg` master, `icon-small.svg` simplified for 16/32 px, `icon-full.svg` full-bleed for maskable/iOS), then run `bin/make-icons.sh` (needs chromium + ImageMagick) and commit the PNG/ICO it writes. `src/pages/og-image.jpg` is the link-preview image; when present, the app page gets og tags pointing to `https://APP_DOMAIN/og-image.jpg`.
- The header status light (`#status-badge`, class `status-light`) is a dot whose state is in its tooltip; it links to `APP_ABOUT_URL` (`./about/` when `src/pages/about/` exists, `APP_HOME_URL` otherwise).

`server/server.js` reads the same `.env` itself (real environment variables win). It serves PeerJS with `allow_discovery: false` and `GET <SIGNALING_PATH>/turn`, which returns short-lived coturn REST credentials (HMAC-SHA1 of `TURN_SECRET`, origin-checked, rate-limited per IP). The client fetches them in `getIceConfig()`.

**When you add a setting**, touch all of these: `.env.example`, the whitelist in `bin/build.sh` (only if the browser needs it), the defaults in `CONFIG`/`SIGNALING`/`APPS` at the top of `src/script.js`, `opencore/docs/configuration.md`, and the table in `server/README.md` (for server keys).

### Client (`src/script.js`, one file of about 2000 lines, tabs)
Sections are marked with `// =====` banners: broadcaster (camera), source menu (camera/screen/off), image filters (canvas 2D with a WebGL fallback, applied to the *sent* track), adaptive bitrate (`getStats()` every 2 s, 3-minute window, percentile budget, `maxBitrate` + `scaleResolutionDownBy` ladder), viewer with push-to-talk, local recorder (MediaRecorder WebM), 1-to-1 calls (`callSession`), then routing.

Key mechanisms that span several functions:
- **Home** (`#selection-view`): one `.blk` per function (`data-pick` = film, watch, video, audio, record, join; the join block is the `#home-join` form, which takes a code or a whole link and calls `routeFromHash()`). The home alone is "paper and ink" (light, or dark with the system): it redefines the color tokens on `body:has(#selection-view.active)`, the video screens keep the dark ones. The `home_pick` cookie remembers the last pick; `markPick()` (also run by `switchView("selection")`) adds the hand-written note and `Halo`, a small WebGL fragment shader behind that block (CSS glow fallback, still frame under reduced motion). Fonts are self-hosted in `src/fonts/` (Poppins for text, Permanent Marker only for hand-written notes; weights 400-600 only, so never use 700+). `applyAppFlags()` hides blocks.
- **Views** are toggled with the `active` class by `switchView()`. **Routing** is hash-based (`routeFromHash()`): `#camera`, `#viewer`, `#record`, `#videocall`, `#audiocall`, `#cam-xxxx` (what the QR code encodes, auto-connect), `#call-xxxx` (join lobby). `applyAppFlags()` hides tiles and blocks routes for apps switched off in `.env`.
- **Placeholder tracks**: the viewer and both call peers always negotiate audio and video m-lines (silent or blank tracks), so the mic, camera, screen or "off" can be swapped later with `RTCRtpSender.replaceTrack()` without renegotiating. Push-to-talk, camera⇄screen⇄off and cam-off all depend on this.
- **Calls** carry a PeerJS data channel with `{cam, screen, mic, bye}` state.
- Screen tracks get `contentHint = "detail"` and are never downscaled by the bitrate ladder.
- Pairing IDs are `cam-`/`call-` + 12 base-36 chars from `crypto.getRandomValues` (`generatePeerId`).
- **Language**: strings are written in English everywhere (HTML and code). The `FR` dictionary near the top of `script.js` (plus `FR_PATTERNS` for strings with a variable part) translates them; `t()` is applied where text is displayed (`showToast`, `updateStatus`, `resetCallStage`, the source menu…) and `translateDom()` translates the static HTML (text nodes, `title`/`placeholder`/`aria-label`). French is picked from `navigator.languages` or the FR/EN switch in the header (home screen only, remembered in localStorage). **Any new user-facing string needs a French entry in `FR`.** The site pages share `src/site.css` (same paper-and-ink language as the app's home, light/dark with the system; diagrams and code blocks are always-dark panels because their inline SVGs are drawn for a dark background; `.kicker`, `.tag` and step numbers are hand-written in Permanent Marker). On `about/` and `a-propos/` a small inline script reads the app's `home_pick` cookie and gives the matching mode card the halo. The site pages are separate files per language: `about/` ↔ `a-propos/`, `tech.html` ↔ `technique.html`, linked with `hreflang` and a `.lang-switch`; edit both when the content changes.
- `log.debug` only prints on localhost (privacy). Use it instead of `console.log`.

### Service worker
`src/sw.js` is shipped but **disabled**: the end of `script.js` unregisters any existing worker, because an earlier version intercepted the PeerJS WebSocket. To re-enable it, the worker must skip `/peerjs/*` and WebSocket traffic.

## Open-core export (`bin/export-opencore.sh`)
The script copies `src/` (minus `pages/`, `site.css`, `sw.js`), `bin/build.sh`, `server/`, `config-samples/`, `.env.example` and `opencore/` (README, HOWTO, LICENSE, `docs/`, `gitignore`) into `../opencore`, replaces `{{REPO_NAME}}`, then **aborts if the export contains the string "beamcam" (any case) or a 64-hex string** (anything that looks like a secret). Then it checks that the result builds from `.env.example`. So:
- `src/app.html`, `src/script.js`, `src/style.css`, `server/`, `config-samples/` and `opencore/` must never contain "BeamCam", "beamcam.live" or any other hard-coded brand or domain. Use `APP_CONFIG` / `{{APP_NAME}}`. Branding belongs only in `src/pages/`, `src/site.css`, `src/sw.js` and `.env`.
- When you add a file under `src/` or `server/` that open core needs, add it to the `cp` list in the script.

## Git quirks
`.gitignore` ignores `bin/`, `docs/*.md` and every dotfile (`.*`). Consequences:
- `bin/build.sh` is tracked (it was force-added). `bin/export-opencore.sh` and `bin/make-icons.sh` are **not** tracked unless force-added.
- `docs/` (`TODO.md` in French, `SECURITY-AUDIT.md`, and an older `docs/CLAUDE.md`) is local-only and partly out of date.
- `../opencore` is a separate git repo (the public one). `../git` and `../peerjs` are siblings outside this repo.

## Docs to keep in sync when behavior changes
- `opencore/docs/*.md`: the public technical docs (architecture, handshake, calls, push-to-talk, adaptive-bitrate, image-filters, recorder, nat-traversal, privacy, limits, configuration, self-hosting). They describe mechanisms, not line numbers. Update the matching page when a feature changes, and the feature table in `opencore/README.md` when you add an app or feature.
- `src/pages/about/index.html` (landing at `/about/`: feature list, how-to, FAQ) and `src/pages/tech.html` (technical page with the architecture SVG): user-facing claims such as "zero third parties" or the feature lists.
- `server/README.md` when `server.js` endpoints or settings change.
- `src/assets/LICENSES.md` when a vendored library (PeerJS 1.5, Lucide, qrcode.js) is bumped. Libraries are vendored by hand, never loaded from a CDN.
- The root `README.md` is stale (it cites `script.js` line ranges, `LICENSE.txt`, `TODO.md` and "three modes"). Prefer the `opencore/` docs as the source of truth, and fix the README when you touch it.
- After a meaningful change, re-run the open-core export so `../opencore` stays current.
