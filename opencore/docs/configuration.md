# Configuration

Everything deployment-specific lives in one `.env` file at the repository root. Nothing
about your domain or your name is hard-coded in `src/`.

```bash
cp .env.example .env
$EDITOR .env
bash bin/build.sh
```

## Who reads what

* **`bin/build.sh`** reads `.env` and writes `dist/config.js` from a **whitelist** of public
  values: name, signaling host/port/path, STUN address, app switches. Secrets are never
  copied into `dist/`.
* **`server/server.js`** reads `.env` itself (real environment variables take precedence),
  including `TURN_SECRET`.
* **`server/install-coturn.sh`** generates `TURN_SECRET` and writes it into `.env`.

The `.env` parser in the build doesn't execute anything: `KEY=VALUE` lines, `#` comments,
optional quotes.

## Keys

| Key | Used by | Default | Meaning |
|-----|---------|---------|---------|
| `APP_NAME` | build | required | Header, tab title, PWA name, recording file names |
| `APP_DOMAIN` | build, server | required | Public hostname. Default for every other host |
| `APP_THEME_COLOR` | build | `#6366f1` | PWA theme colour |
| `APP_HOME_URL` | build | `./` | Where the header logo links |
| `APP_LIVE` | build | off | Phone camera + viewer tiles |
| `APP_VIDEOCALL` | build | off | 1-to-1 video call tile (and the camera button inside calls) |
| `APP_AUDIOCALL` | build | off | 1-to-1 audio call tile |
| `APP_EDITOR` | build | off | Local recorder tile |
| `SIGNALING_HOST` | build | `APP_DOMAIN` | Public host of the signaling server |
| `SIGNALING_PORT` | build | `443` | Public port (your proxy) |
| `SIGNALING_PATH` | build, server | `/peerjs` | Mount path; must match the proxy |
| `SIGNALING_SECURE` | build | `1` | HTTPS/WSS to the signaling server. Empty only for plain-HTTP tests on `localhost` |
| `PORT`, `HOST` | server | `9000`, `127.0.0.1` | Where `server.js` listens. Keep it behind the proxy |
| `ALLOWED_ORIGINS` | server | `https://APP_DOMAIN` | Origins allowed to request TURN credentials |
| `TURN_HOST`, `TURN_PORT` | build, server | `APP_DOMAIN`, `3478` | Advertised STUN/TURN address |
| `TURN_TTL` | server | `86400` | TURN credential lifetime, seconds |
| `TURN_SECRET` | server | none | coturn `static-auth-secret`. Server-side only |

## App switches

Each switch is `1` (on) or empty (off). An app that's off loses its tile on the home screen,
and its URL entry points (`#camera`, `#videocall`, ...) stop working. A few useful combinations:

| Deployment | `LIVE` | `VIDEOCALL` | `AUDIOCALL` | `EDITOR` |
|------------|:-:|:-:|:-:|:-:|
| Everything | 1 | 1 | 1 | 1 |
| Baby monitor only | 1 | | | |
| Family calls | | 1 | 1 | |
| Intercom (voice only, no camera button at all) | | | 1 | |
| Screen recorder | | | | 1 |

With `APP_LIVE` off, the "viewer" tile becomes **Join a call**, where a typed `call-…` code
leads to the lobby.
