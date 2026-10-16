# NAT traversal: same Wi-Fi, mesh, 4G

**Same network** (including Wi-Fi mesh systems, which are one LAN behind several access
points): the host candidates connect directly. Video travels over your local network and
never reaches the internet. Only the initial handshake does.

**Across networks**, each device asks the STUN server for its public address, and the two
punch through their NATs. When that fails (symmetric NAT, carrier-grade NAT, corporate
firewall), TURN relays the packets. They are still **encrypted end to end**: the relay only
forwards DTLS-SRTP ciphertext.

Both peers use `iceTransportPolicy: "all"`. Forcing `"relay"` would push every byte through
your server, and it broke connections that would have worked directly.

## Ports

| Port | Protocol | What |
|------|----------|------|
| 443 | TCP | Static files + signaling (WebSocket) through your reverse proxy |
| 3478 | UDP + TCP | STUN / TURN |
| 49152-65535 | UDP | TURN relay allocations |

If the relay ports are closed, TURN allocations succeed but carry nothing, which is a
confusing failure. Open them.

## LAN-only

Two browsers can't find each other without a rendezvous point: web pages have no
mDNS/Bonjour API. Run the whole stack (proxy, `server.js`, coturn) on a machine inside the
house, point `APP_DOMAIN` at it, and signaling, media and relay never leave your network.
Remove the `denied-peer-ip` lines from `/etc/turnserver.conf` in that case, since they forbid
relaying into private ranges. Camera access still requires HTTPS, so give that machine a
certificate (a local CA, or a real domain resolving to a private IP with a DNS-01 certificate).
