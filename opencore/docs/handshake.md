# The handshake, step by step

1. **The camera** generates a peer id with `crypto.getRandomValues` (8 random bytes, rendered
   as `cam-` + 12 base-36 characters), registers it with the signaling server and shows it
   as text and as a QR code of `https://<APP_DOMAIN>/#cam-…`.
2. **The viewer** opens with an anonymous id. A `#cam-…` hash in the URL (from the QR code)
   is queued and dialled as soon as the peer is open, so there's no race with a timer.
3. The viewer **calls** the camera with a *placeholder stream*: a 1 fps black canvas plus a
   silent `AudioContext` track. This is on purpose. The SDP offer then contains both an audio
   and a video m-line, so either side can later send real media in both directions without
   renegotiating. Push-to-talk depends on it, and so do calls.
4. The camera **auto-answers** with its real `MediaStream` (720p ideal, chosen frame rate,
   mic on). Its `call` handler is attached *before* the camera permission prompt resolves:
   PeerJS doesn't replay missed events, so a viewer who scans while the prompt is still up
   would otherwise be dropped.
5. **ICE** runs: host candidates (LAN), server-reflexive (STUN), relay (TURN). The best working
   pair wins.
6. From here, the server is out of the loop until someone hangs up.

```js
// viewer: offer audio + video even though there is nothing to send yet
const canvasStream = canvas.captureStream(1);
const silence = new AudioContext().createMediaStreamDestination();
const dummy = new MediaStream([
  ...canvasStream.getVideoTracks(), ...silence.stream.getAudioTracks()
]);
currentCall = peer.call(targetId, dummy);
```

## TURN credentials

Before creating its peer, each client fetches `GET <SIGNALING_PATH>/turn`. The signaling
server answers with an `iceServers` list containing a short-lived TURN credential
(coturn's REST-API scheme):

```
username   = "<unix expiry>:user"
credential = base64( HMAC-SHA1( TURN_SECRET, username ) )
```

coturn recomputes the HMAC with the same secret and checks the expiry. The secret itself
never leaves the server. If the endpoint can't be reached, the client falls back to STUN only,
which still covers most networks.
