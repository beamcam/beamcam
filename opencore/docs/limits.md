# Known limits

* **Foreground only on mobile.** iOS and Android suspend camera capture in background tabs.
  The Screen Wake Lock API keeps the display on while streaming, and is re-acquired when the
  tab becomes visible again. Don't switch apps on the camera phone.
* **No virtual camera.** A web page can't register a system camera device. To use a phone as
  a webcam in a meeting app, capture the viewer window in OBS and use its Virtual Camera.
* **No screen sharing from phones.** Mobile browsers don't implement `getDisplayMedia()`.
* **One to one by design.** One viewer per camera, two people per call. Group calls need an
  SFU, which means a media server: that's a different product.
* **No night vision.** Phone sensors don't see infrared. Add a little light, or use the
  brightness and grayscale filters.
* **Internet needed to connect**, unless you run the [LAN-only setup](nat-traversal.md#lan-only):
  the handshake goes through the signaling server even when both devices share a Wi-Fi.
* **No offline install.** An earlier Service Worker intercepted the signaling WebSocket; the
  app now unregisters any worker on load.
* **Not a safety device.** As a baby monitor it's a convenience: if the Wi-Fi drops, the battery
  dies or the browser gets killed, the stream stops.
