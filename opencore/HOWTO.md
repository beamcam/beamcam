# HOWTO: call your parents and watch your kid without Meta, Google or Apple

This is for people who know what a W3C standard is and would rather run two small daemons
than hand their family's living room to an ad company. You need about an hour, a domain name
and a small server.

## 0. Why this works at all

Every browser on every phone and computer already contains a full video-calling stack:
camera access ([Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)),
real-time encrypted transport ([WebRTC](https://www.w3.org/TR/webrtc/), with ICE, DTLS and
SRTP underneath), codecs and congestion control. FaceTime, WhatsApp and Meet are wrappers
around the same technology, plus an account system and a business model.

The only things a browser can't do alone:

1. **Find the other browser.** That's the *signaling server* (`server/server.js`): it passes
   a few kilobytes of connection details between the two devices, then gets out of the way.
2. **Get through some NATs and firewalls.** That's *coturn*: STUN to learn public addresses,
   TURN to relay (still encrypted) packets when no direct path exists.

You run both. The video never touches them on a direct path, and is ciphertext when it does.

## 1. What you need

| Thing | Notes |
|-------|-------|
| A Linux server with a public IP | The cheapest VPS is enough: signaling is tiny, relaying is rare |
| A domain or subdomain pointing at it | e.g. `cam.example.org`. HTTPS is mandatory for camera access |
| Node.js ≥ 18 | For the signaling server |
| Caddy or nginx | Caddy gets the certificate for you |
| Open ports | 443/tcp, 3478/udp+tcp, 49152-65535/udp |

## 2. Get it

```bash
git clone https://github.com/l3dlp/{{REPO_NAME}}.git /srv/cam
cd /srv/cam
cp .env.example .env
```

Edit `.env`. The minimum:

```ini
APP_NAME=Family Cam
APP_DOMAIN=cam.example.org

APP_LIVE=1          # baby monitor / walkie-talkie
APP_VIDEOCALL=1     # video calls
APP_AUDIOCALL=1     # voice calls
APP_EDITOR=         # local recorder: off
```

Every key is documented in `.env.example` and [docs/configuration.md](docs/configuration.md).

## 3. Install the two daemons

```bash
cd server
./install.sh                 # npm dependencies
sudo ./install-coturn.sh     # installs coturn, generates TURN_SECRET into ../.env
sudo ./install-service.sh    # runs server.js under systemd as "webrtc-signaling"
cd ..
```

Open the firewall (ufw example):

```bash
sudo ufw allow 443/tcp
sudo ufw allow 3478/udp && sudo ufw allow 3478/tcp
sudo ufw allow 49152:65535/udp
```

## 4. Build and serve

```bash
bash bin/build.sh            # writes dist/ from src/ and .env
```

Caddy, in `/etc/caddy/Caddyfile` (copied from `config-samples/Caddyfile`):

```caddy
cam.example.org {
    root * /srv/cam/dist
    file_server
    @signaling path /peerjs /peerjs/*
    reverse_proxy @signaling 127.0.0.1:9000
}
```

```bash
sudo systemctl reload caddy
```

## 5. Check

```bash
curl -s https://cam.example.org/peerjs/        # {"name":"PeerJS Server",...}
curl -s https://cam.example.org/peerjs/turn    # {"ttl":86400,"iceServers":[...]}
```

Optional, to prove the relay works end to end (`coturn` ships `turnutils_uclient`):

```bash
J=$(curl -s https://cam.example.org/peerjs/turn)
U=$(echo "$J" | python3 -c 'import json,sys;print(json.load(sys.stdin)["iceServers"][1]["username"])')
P=$(echo "$J" | python3 -c 'import json,sys;print(json.load(sys.stdin)["iceServers"][1]["credential"])')
turnutils_uclient -y -n 1 -c -u "$U" -w "$P" cam.example.org     # no "ERROR" = good
```

## 6. Use it

### Call your parents

1. Open `https://cam.example.org`, tap **Video Call** (or **Audio Call**).
2. Send them the link from **Copy link** (text, email, whatever they read), or let them scan
   the QR code on your screen.
3. They tap **Join with video**. That's it: no account, no install, works on an old tablet.

While talking: mute, camera on/off, front/back camera, **share your screen** from a computer
(to show them where that setting is), fullscreen. When they hang up, your page keeps the
same link and waits, so they can call back.

Tip: add the page to their home screen once (Share → Add to Home Screen). It then opens
like an app.

### Watch your kid sleep

1. An old phone, **plugged in**, propped up facing the cot. Open the site, tap **Phone Camera**,
   allow camera and microphone.
2. Leave the bitrate on **Auto**, set **15 fps**. Dark room? Open **Image & quality**, raise
   brightness, slide grayscale to 100%: cleaner picture, less data.
3. On your phone, scan the QR code and tap **Unmute**. Hold the talk button to say "shhh"
   without going in.
4. Keep the page in the foreground on both phones. The camera phone keeps its screen awake
   by itself.

It's a convenience, not a certified safety device: if the Wi-Fi drops or a battery dies, the
stream stops.

### Intercom, workshop, gate

Set only `APP_AUDIOCALL=1` and rebuild: voice calls only, no camera button anywhere.

## 7. Keep it healthy

* **Codes are keys.** Whoever has a `cam-…` or `call-…` link can watch or join. Don't post them.
* **Update** now and then: `git pull && bash bin/build.sh && sudo systemctl restart webrtc-signaling`.
* **Rotate the TURN secret** if it ever leaks: rerun `sudo server/install-coturn.sh`, then
  restart `webrtc-signaling`.
* Logs: `journalctl -u webrtc-signaling -f` and `/var/log/turnserver.log`.

## 8. Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Camera never starts | Not HTTPS, or permission denied in the browser's site settings |
| "Connection timeout" between two networks | 3478 or 49152-65535/udp closed, or `TURN_SECRET` in `.env` differs from coturn's (restart `webrtc-signaling` after `install-coturn.sh`) |
| `/peerjs/turn` returns 403 | The page is served from an origin not in `ALLOWED_ORIGINS` |
| `/peerjs/` returns 502 | `webrtc-signaling` not running: `systemctl status webrtc-signaling` |
| Works on Wi-Fi, fails on 4G | Carrier-grade NAT: TURN is needed, see the first two rows |
| No sound on iPhone | Tap the page once (the "Tap to enable sound" button); iOS blocks autoplay with sound |
| Stream stops when the phone locks | Mobile OSes suspend background tabs: keep the page in front, plugged in |
| Echo during a call | Two devices on speaker in the same room. Use headphones, or separate rooms |

## 9. Only on your own network

Run the same stack on a machine at home, point `APP_DOMAIN` at it, and nothing ever leaves
the house: see [docs/nat-traversal.md](docs/nat-traversal.md#lan-only).
