# Documentation

How it is built, from the pairing code to the last RTP packet.

| Page | What's in it |
|------|--------------|
| [Architecture](architecture.md) | Stack, the two planes, code map, URL routing |
| [Configuration](configuration.md) | `.env` reference, app switches, what the build does |
| [The handshake](handshake.md) | Pairing codes, the placeholder-stream trick, ICE |
| [NAT traversal](nat-traversal.md) | Same Wi-Fi, mesh, 4G, corporate firewalls, LAN-only |
| [Push-to-talk](push-to-talk.md) | Talking back to the camera with one `replaceTrack()` |
| [1-to-1 calls and screen sharing](calls.md) | Both ends sending, camera ⇄ screen ⇄ off |
| [Adaptive bitrate](adaptive-bitrate.md) | 3-minute window, percentile budget, hysteresis |
| [Image filters](image-filters.md) | Brightness / contrast / grayscale on what is sent |
| [Local recorder](recorder.md) | MediaRecorder, nothing uploaded |
| [Privacy model](privacy.md) | What the server sees (almost nothing) |
| [Self-hosting](self-hosting.md) | The three daemons, step by step |
| [Known limits](limits.md) | What it doesn't do, and why |
