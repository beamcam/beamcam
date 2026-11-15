# Privacy model

* **Media is end-to-end encrypted** by WebRTC (DTLS-SRTP, mandatory, not optional). A TURN
  relay only forwards ciphertext.
* **No long-lived secrets in the browser.** TURN credentials are minted per session by the
  signaling server: an expiry timestamp and an HMAC of it, valid 24 h. The coturn secret
  stays on the server, and the build never copies it into `dist/`.
* **No accounts, no database.** Peer ids are ephemeral and disappear when the tab closes.
* **No third-party requests.** PeerJS, Lucide, qrcode.js and the fonts (Poppins, Permanent
  Marker) are vendored and served by your own host. No CDN, analytics or pixels. (`install-coturn.sh` queries ifconfig.me once
  to learn the server's public IP; set `EXTERNAL_IP` to skip it.)
* **One preference cookie, no tracking.** `home_pick` remembers which tool was used last
  (`film`, `watch`, `video`, `audio`, `record` or `join`) so the home screen can highlight
  it. First-party, one year, no identifier. The language choice, if you switch it by hand,
  is kept in `localStorage`.
* **Client logs are off in production.** Debug logging only runs on `localhost`.
* **Discovery is disabled.** The signaling server won't list connected peers.
* **The pairing code is a bearer token.** It's random enough to be unguessable in practice,
  and it can't be listed. But whoever holds the code (or the QR code, or the link) can watch
  or join, so treat it like a key.

## What your server sees

| Component | Sees | Doesn't see |
|-----------|------|-------------|
| Reverse proxy | IPs, static file requests | Anything inside the WebSocket beyond PeerJS JSON |
| `server.js` | Peer ids, SDP offers/answers (codecs, ICE candidates = IP addresses) | Audio, video, screen |
| coturn | IPs and byte counts of *relayed* sessions | Content: it's ciphertext |
