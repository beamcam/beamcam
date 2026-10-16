# 1-to-1 calls and screen sharing

Same signaling and the same pairing flow as the camera, but both ends send. The host
registers a `call-…` id and shows a QR code; the joiner lands in a lobby: **Join with video**
or **Join audio only**. That tap is also the user gesture iOS wants before it plays sound.

* **Both m-lines are always negotiated.** With the camera off, a 1 fps black canvas track
  stands in for the offer/answer, then the sender gets `replaceTrack(null)`: nothing is
  encoded, nothing is sent.
* **Camera off really is off.** The track is stopped, the hardware is released, the camera
  light goes out. Turning it back on is `getUserMedia()` + `replaceTrack()`, no renegotiation.
* **A data channel carries state**: `{cam, screen, mic}`, and `{bye}` on hang-up. The other
  side shows an avatar or a "Muted" badge instead of guessing from a black frame. ICE state
  is watched too, because PeerJS doesn't always fire `close` on the far end.
* **Full-duplex audio** with the browser's echo cancellation, noise suppression and auto gain.
  Headphones still beat a phone speaker at arm's length.
* **Strictly 1-to-1.** A second caller is turned away while the line is busy. When the call
  ends, the host keeps its code and waits for the next caller.
* Adaptive bitrate and the screen wake lock run on both ends.

## Camera ⇄ screen ⇄ off

In the camera mode and in calls, the camera button opens a menu: **Camera**, **Share screen**,
**Turn video off**. Each choice is one `replaceTrack()` on the existing video sender: the call
never drops.

* Screen tracks come from `getDisplayMedia()` (1080p ideal, 15 fps) and get
  `contentHint = "detail"`: under pressure the encoder drops frames, not resolution, so text
  stays readable.
* The adaptive bitrate never applies `scaleResolutionDownBy` to a screen.
* The receiver is told (`{screen: true}`) and switches to `object-fit: contain`: a demo is
  shown whole, never cropped. The camera viewer always uses `contain`.
* The browser's own "Stop sharing" button fires `ended` on the track: the app goes back to
  whatever was on before (camera, or nothing).
* Mobile browsers don't implement `getDisplayMedia()`; the option is shown disabled there.
* Fullscreen button (and double-click on the remote video) for watching demos.
