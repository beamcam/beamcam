# Adaptive bitrate: measured, not guessed

WebRTC's own congestion control (GCC) already reacts within seconds. It's good at reacting
and bad at committing: on a flaky link it climbs, gets burned, drops, and does it again.
**Auto** mode (the default) sits on top and picks a ceiling the link has *sustained*,
computed locally on the sending device:

* Every **2 s**, read `getStats()`: `availableOutgoingBitrate` from the nominated candidate
  pair, `fractionLost` and RTT from `remote-inbound-rtp`. On Firefox, which has no bandwidth
  estimate, the actual send rate from `outbound-rtp.bytesSent` is used instead.
* Keep a sliding window of **90 samples = 3 minutes**.
* Ignore the first 10 s: the estimator starts low and ramps up, and those samples would drag
  the budget down for three minutes.
* Budget = **20th percentile** of measured bandwidth. One good second doesn't raise it; the
  link has to hold that speed most of the time.
* Loss over the last 30 s above 2% / 5% cuts the budget by 15% / 30%.
* Move along a ladder, applied with `RTCRtpSender.setParameters()`:

| Level | `maxBitrate` | `scaleResolutionDownBy` | ≈ from 720p |
|:-:|--:|:-:|--|
| 0 | 300 kbps | 2 | 360p |
| 1 | 600 kbps | 2 | 360p |
| 2 | 1 Mbps | 1.5 | 480p |
| 3 | 1.5 Mbps | 1 | 720p (start) |
| 4 | 2.5 Mbps | 1 | 720p |
| 5 | 4 Mbps | 1 | 720p, high detail |

**Hysteresis band.** The bandwidth estimate tends to sit close to what's already being sent,
so "budget below the cap" alone would ratchet quality down forever. Instead it *drops* only
when the sustained budget falls under 90% of the current cap, straight to the highest level
that fits in 85% of it. It *climbs* one level at a time, only when the budget clears the next
level by 25% and loss stays under 2%. Bad news is acted on immediately; good news has to last.

Screen shares keep full resolution whatever the level (see [calls](calls.md)). Picking a fixed
bitrate in the camera settings turns all of this off.

Colour depth is not a lever: real-time codecs (VP8/VP9/H.264) encode 8-bit 4:2:0, there's no
"fewer colours" knob. The closest real equivalent is the [grayscale filter](image-filters.md).
