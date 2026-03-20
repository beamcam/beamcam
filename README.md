# BeamCam

Turn any phone into a webcam in 10 seconds.

No app. No drivers. Just a browser.

BeamCam uses WebRTC to stream video directly between devices.

## Goal

A Progressive Web App (PWA) that transforms your phone into a webcam, enables remote camera viewing, and provides local recording capabilities using WebRTC peer-to-peer technology.

## Features

- 📱 **Phone Camera Mode** - Use your mobile device as a wireless webcam
- 🖥️ **Desktop Viewer Mode** - View camera feeds from remote devices
- 🎥 **Local Recorder Mode** - Record from camera or screen with audio
- 🔒 **Private & Secure** - Peer-to-peer WebRTC connections, video never relayed through servers
- 🌐 **Progressive Web App** - Install on any device
- 🎨 **Modern UI** - Glassmorphic design with smooth animations

## How It Works

### Architecture

**Client-side app** with signaling server infrastructure:

- **WebRTC** via PeerJS for peer-to-peer video streaming
- **PeerJS Server** - Custom signaling server at beamcam.live
- **STUN/TURN** - coturn server for NAT traversal
- **MediaStream API** for camera/screen capture
- **MediaRecorder API** for local video recording
- **Service Worker** - Currently disabled (see Known Issues below)

### Application Modes

#### 1. Phone Camera (Broadcaster)

Turn your phone into a wireless webcam:

1. Select "Phone Camera" mode
2. Share the generated pairing code (format: `cam-XXXX`)
3. Your camera feed is ready to stream

**Implementation**: `src/script.js:86-168`

#### 2. Desktop Viewer

Connect to a remote camera:

1. Select "Desktop Viewer" mode
2. Enter the pairing code from the broadcaster
3. View the live camera feed

**Implementation**: `src/script.js:173-226`

#### 3. Local Recorder

Record camera or screen locally:

1. Select "Local Recorder" mode
2. Choose camera or screen capture
3. Record, preview, and download as WebM

**Implementation**: `src/script.js:232-358`

## Quick Start

### Using the App

Visit **https://beamcam.live** and:

1. Select your mode from the main screen
2. Grant camera/microphone permissions when prompted
3. Share pairing codes for broadcaster/viewer connections

### Development

No build tools required for basic development:

```bash
# Edit source files
vim src/script.js
vim src/style.css
vim src/index.html

# Build production version
bash bin/build.sh

# Hard reload browser (Cmd+Shift+R / Ctrl+Shift+F5) to see changes
```

### Server Requirements

The app requires two backend services (already running on beamcam.live):

1. **PeerJS Server** - WebRTC signaling (port 9000, proxied via Caddy)
2. **coturn** - STUN/TURN server for NAT traversal (port 3478)

See `server/` directory for server setup scripts.

## Project Structure

```
beamcam/
├── src/
│   ├── index.html      # HTML fragment (no <html>/<head>/<body> tags)
│   ├── script.js       # Application logic
│   └── style.css       # Styles with CSS variables
│   └── sw.js           # Service Worker for PWA
├── dist/
│   ├── index.html      # Complete production HTML
│   ├── script.js       # Production JavaScript
│   └── style.css       # Production CSS
├── bin/
│   └── build.sh        # Build script for production
├── README.md           # This file
└── LICENSE.txt         # MIT License

```

## Technical Details

### State Management

Global state variables:
- `peer` - PeerJS instance for WebRTC connections
- `localStream` - MediaStream from camera/screen
- `currentCall` - Active peer connection
- `currentFacingMode` - Camera orientation (`"environment"` or `"user"`)
- `mediaRecorder` - MediaRecorder instance for recording
- `recordedChunks` - Array of recorded video blobs

### View Management

Views are managed through simple show/hide with the `active` class:
- **Selection view** - Mode chooser (default)
- **Broadcaster view** - Camera feed with pairing code overlay
- **Viewer view** - Connection prompt + remote video display
- **Local recorder view** - Capture setup, recording, and playback controls

### Video Recording

- **Format**: WebM (VP9 codec preferred with fallback)
- **Quality**: 1920x1080 ideal resolution
- **Audio**: Captured with video
- **Storage**: In-memory until download

## Browser Requirements

- Modern browser with WebRTC support (Chrome, Firefox, Safari, Edge)
- HTTPS or localhost for camera/microphone access
- Service Worker support for PWA features

## Building for Production

Run the build script to generate production files:

```bash
./bin/build.sh
```

This creates a complete, standalone HTML file in `dist/` with:
- Embedded fonts and styles
- Minified resources
- Complete `<head>` section with PWA metadata

## PWA Installation

Once deployed over HTTPS, users can install the app:

1. Open the app in a supported browser
2. Look for "Install" or "Add to Home Screen" prompt
3. The app will work offline after installation

## Privacy & Security

- **Client-side processing** - All video processing happens in your browser
- **Peer-to-peer connections** - Video streams directly between devices via WebRTC
- **No data storage** - Recordings stay on your device until downloaded
- **Signaling only** - PeerJS server only used for initial peer discovery, never for video relay
- **TURN fallback** - Only used if direct P2P connection fails (NAT traversal)

## Known Issues

### Service Worker Disabled

The Service Worker has been temporarily disabled because it was interfering with WebRTC WebSocket connections to the PeerJS signaling server.

**Impact**:
- No offline support
- No caching
- App requires active internet connection

**Future Fix**: Modify Service Worker to exclude `/peerjs/*` routes and WebSocket connections from fetch interception.

**Technical Details**: See `TODO.md` for full debugging history and solution.

## License

MIT License - Copyright (c) 2026 L3DLP

See [LICENSE.txt](LICENSE.txt) for full details.

## Contributing

This is a simple, dependency-free project. To contribute:

1. Edit files in `src/`
2. Test changes by opening `dist/index.html` after running `./bin/build.sh`
3. Ensure PWA features work with the service worker
4. Submit your changes

## Credits

Built with:
- [PeerJS](https://peerjs.com/) - WebRTC peer-to-peer connections
- [Lucide Icons](https://lucide.dev/) - Beautiful icon library
- Modern web APIs (MediaStream, MediaRecorder, Service Worker)
