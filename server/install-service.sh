#!/bin/bash

# Install PeerJS Server as systemd service

set -e

if [ "$EUID" -ne 0 ]; then
    echo "❌ Please run as root: sudo $0"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="beamcam-peerjs"
USER="${SUDO_USER:-www-data}"

echo "🔧 Installing PeerJS Server as systemd service..."
echo ""
echo "Service name: $SERVICE_NAME"
echo "User: $USER"
echo "Directory: $SCRIPT_DIR"
echo ""

# Create systemd service file
cat > "/etc/systemd/system/${SERVICE_NAME}.service" << EOF
[Unit]
Description=BeamCam PeerJS Server
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$SCRIPT_DIR
ExecStart=/usr/bin/node $SCRIPT_DIR/server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE_NAME

Environment=NODE_ENV=production
Environment=PORT=9000
Environment=HOST=0.0.0.0
Environment=PATH_PREFIX=/peerjs

[Install]
WantedBy=multi-user.target
EOF

echo "✓ Service file created: /etc/systemd/system/${SERVICE_NAME}.service"

# Reload systemd
systemctl daemon-reload
echo "✓ Systemd reloaded"

# Enable service
systemctl enable "$SERVICE_NAME"
echo "✓ Service enabled"

# Start service
systemctl start "$SERVICE_NAME"
echo "✓ Service started"

echo ""
echo "✅ Installation complete!"
echo ""
echo "Service commands:"
echo "  Status:  sudo systemctl status $SERVICE_NAME"
echo "  Stop:    sudo systemctl stop $SERVICE_NAME"
echo "  Restart: sudo systemctl restart $SERVICE_NAME"
echo "  Logs:    sudo journalctl -u $SERVICE_NAME -f"
echo ""
echo "📝 Don't forget to configure your reverse proxy (nginx/apache) to proxy:"
echo "   https://beamcam.live/peerjs -> http://localhost:9000/peerjs"
echo ""
