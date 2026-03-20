#!/bin/bash

# Build script for BeamCam PWA
# Generates production-ready static files in dist/

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SRC_DIR="$PROJECT_ROOT/src"
DIST_DIR="$PROJECT_ROOT/dist"

echo "🔨 Building BeamCam PWA..."
echo "   Source: $SRC_DIR"
echo "   Output: $DIST_DIR"
echo ""

# Create dist directory
mkdir -p "$DIST_DIR"

# Copy JavaScript, CSS, and Service Worker
echo "📦 Copying assets..."
cp "$SRC_DIR/script.js" "$DIST_DIR/script.js"
cp "$SRC_DIR/style.css" "$DIST_DIR/style.css"
cp "$SRC_DIR/sw.js" "$DIST_DIR/sw.js"

# Build complete HTML file
echo "📄 Building index.html..."

cat > "$DIST_DIR/index.html" << 'EOF'
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>BeamCam</title>
    <meta name="description" content="Use your phone as a webcam, view remote cameras, or record locally. Serverless PWA with peer-to-peer video streaming.">

    <!-- PWA Meta Tags -->
    <meta name="theme-color" content="#6366f1">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="apple-mobile-web-app-title" content="BeamCam">

    <!-- PWA Manifest -->
    <link rel="manifest" href="./manifest.json">

    <!-- Fonts (system fallback) -->
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
        }
    </style>

    <!-- Styles -->
    <link rel="stylesheet" href="./style.css">

    <!-- PeerJS (local) -->
    <script src="./assets/peerjs.min.js"></script>

    <!-- QRCode.js (local) -->
    <script src="./assets/qrcode.min.js"></script>

    <!-- Lucide Icons (local) -->
    <script src="./assets/lucide.min.js"></script>
</head>
<body>
EOF

# Append the HTML content from src
cat "$SRC_DIR/index.html" >> "$DIST_DIR/index.html"

# Close HTML tags
cat >> "$DIST_DIR/index.html" << 'EOF'

<!-- Application Script -->
<script src="./script.js"></script>
</body>
</html>
EOF

# Create PWA manifest
echo "📱 Creating manifest.json..."

cat > "$DIST_DIR/manifest.json" << 'EOF'
{
  "name": "BeamCam",
  "short_name": "BeamCam",
  "description": "Use your phone as a webcam, view remote cameras, or record locally",
  "start_url": "./index.html",
  "display": "standalone",
  "background_color": "#050505",
  "theme_color": "#6366f1",
  "orientation": "any",
  "icons": [
    {
      "src": "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' fill='%236366f1'/><circle cx='50' cy='40' r='20' fill='white'/><rect x='30' y='60' width='40' height='25' rx='5' fill='white'/></svg>",
      "sizes": "512x512",
      "type": "image/svg+xml",
      "purpose": "any maskable"
    }
  ],
  "categories": ["utilities", "photo", "video"],
  "screenshots": []
}
EOF

echo ""
echo "✅ Build complete!"
echo ""
echo "📂 Output files:"
echo "   - $DIST_DIR/index.html"
echo "   - $DIST_DIR/script.js"
echo "   - $DIST_DIR/style.css"
echo "   - $DIST_DIR/manifest.json"
echo "   - $DIST_DIR/sw.js"
echo ""
echo "🚀 To test locally:"
echo "   cd $DIST_DIR && python3 -m http.server 8000"
echo "   Then open: http://localhost:8000"
echo ""
echo "📱 For PWA features, serve over HTTPS or use localhost"
