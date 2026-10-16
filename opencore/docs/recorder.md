# Local recorder

Camera (`getUserMedia`, 1080p ideal) or screen (`getDisplayMedia`), with audio, goes into a
`MediaRecorder`. VP9 is used when available, otherwise the browser's default codec. Chunks
are collected every 100 ms in memory, assembled into a `Blob`, played back in the page, then
downloaded or discarded.

No network is involved: once the page is loaded, it works offline. Mind long recordings:
everything lives in RAM until you download it.

Enabled with `APP_EDITOR=1`.
