# Signaling server

`server.js` does two small jobs:

1. **PeerJS signaling** over HTTP + WebSocket: browsers exchange SDP offers/answers and
   ICE candidates through it. It never sees audio or video. Discovery (listing who is
   online) is disabled.
2. **TURN credentials** at `GET <SIGNALING_PATH>/turn`: short-lived coturn REST-API
   credentials, `username = <expiry>:user`, `credential = base64(HMAC-SHA1(TURN_SECRET, username))`,
   valid `TURN_TTL` seconds (24 h by default). Requests from other origins get a 403, and each
   IP is limited to 30 requests per 10 minutes.

## Settings

Read from the repository's `.env` (real environment variables win):

| Key | Default | Meaning |
|-----|---------|---------|
| `APP_DOMAIN` | `localhost` | Public hostname; default for `TURN_HOST` and `ALLOWED_ORIGINS` |
| `PORT` / `HOST` | `9000` / `127.0.0.1` | Listen address. Keep it on localhost, behind the reverse proxy |
| `SIGNALING_PATH` | `/` | Mount path, must match the proxy (`/peerjs` in the samples) |
| `TURN_SECRET` | none | coturn `static-auth-secret`. **Required**: the server refuses to start without it |
| `TURN_HOST` / `TURN_PORT` | `APP_DOMAIN` / `3478` | Advertised STUN/TURN address |
| `TURN_TTL` | `86400` | Credential lifetime, in seconds |
| `ALLOWED_ORIGINS` | `https://APP_DOMAIN` | Comma-separated origins allowed to request credentials |

## Install

```bash
./install.sh                  # npm dependencies
sudo ./install-coturn.sh      # coturn + writes TURN_SECRET into ../.env
sudo ./install-service.sh     # systemd unit (SERVICE_NAME=webrtc-signaling by default)
```

## Check

```bash
curl -s https://<APP_DOMAIN>/peerjs/          # {"name":"PeerJS Server",...}
curl -s https://<APP_DOMAIN>/peerjs/turn      # {"ttl":86400,"iceServers":[...]}

# real TURN allocation with those credentials (package coturn-utils / coturn)
turnutils_uclient -y -n 1 -c -u '<username>' -w '<credential>' <TURN_HOST>
```
