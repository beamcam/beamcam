# Push-to-talk

Because of the [placeholder stream](handshake.md), the viewer already has a negotiated
audio sender carrying silence. Talking back is one call:

```js
const sender = pc.getSenders().find(s => s.track?.kind === "audio");
const mic = (await getUserMedia({ audio: true })).getAudioTracks()[0];
await sender.replaceTrack(mic);   // once; no renegotiation
mic.enabled = pressed;            // on every press / release
```

The mic is requested on the first press and kept. After that, press and release only flip
`track.enabled`, so there's no delay and no permission prompt mid-sentence.

On the camera side, the incoming stream plays through a hidden `<audio>` element, and a
speaker button next to the mic button mutes it. The browser's acoustic echo cancellation
keeps the phone's own speaker from feeding back into its mic.

The button uses pointer capture (mouse, touch and pen behave the same), and holding Space
works on a keyboard.
