# Image filters: applied to what is sent

Brightness, contrast and grayscale (camera mode, "Image & quality") change the stream the
viewer receives, not just the local preview. When any slider is off neutral, the video track
goes through a small pipeline:

```
camera track → hidden <video> → <canvas> → canvas.captureStream() → RTCRtpSender.replaceTrack()
```

* **Canvas 2D `ctx.filter`** (`grayscale() contrast() brightness()`) where supported: Chrome,
  Edge, Firefox. GPU-backed.
* **WebGL fragment shader** fallback for browsers without `ctx.filter`: luma mix, then
  contrast around mid-grey, then gain.
* Drawn once per camera frame with `requestVideoFrameCallback`, falling back to
  `requestAnimationFrame`. The hidden `<video>` is kept in the document, because iOS only
  decodes frames for attached elements.
* Back at neutral values, the pipeline is torn down and the raw camera track is swapped back
  in, so it costs nothing when unused.

Grayscale also saves bandwidth: flat chroma planes compress to almost nothing, so at the same
bitrate the encoder spends everything on luminance detail. Useful in a dark nursery at 500 kbps.
