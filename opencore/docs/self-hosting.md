# Self-hosting

Three pieces, all boring on purpose: a static web root, a 100-line Node process, and coturn.

## Requirements

* A Linux box with a public IP (a small VPS is plenty), or a machine at home for a
  [LAN-only setup](nat-traversal.md#lan-only).
* A domain name pointing at it. Browsers only allow camera access over **HTTPS**.
* Node.js ≥ 18, and a reverse proxy: Caddy (easiest, automatic TLS) or nginx.
* Open ports: 443/tcp, 3478/udp+tcp, 49152-65535/udp.

## Steps

```bash
git clone <this repository> cam && cd cam
cp .env.example .env && $EDITOR .env        # APP_NAME, APP_DOMAIN, app switches

cd server
./install.sh                                # npm dependencies
sudo ./install-coturn.sh                    # coturn, and TURN_SECRET written into ../.env
sudo ./install-service.sh                   # systemd unit for server.js
cd ..

bash bin/build.sh                           # -> dist/
```

Then serve `dist/` and proxy `/peerjs` with one of the samples in `config-samples/`
(replace `cam.example.org` and the root path).

## Check

```bash
curl -s https://cam.example.org/peerjs/          # {"name":"PeerJS Server",...}
curl -s https://cam.example.org/peerjs/turn      # {"ttl":86400,"iceServers":[...]}
```

Open `https://cam.example.org/#camera` on a phone and scan the QR code with another device.

## Updating

```bash
git pull && bash bin/build.sh && sudo systemctl restart webrtc-signaling
```

`bin/build.sh` is the deploy: it rewrites `dist/` in place.
