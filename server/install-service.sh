#!/bin/bash

# Install the signaling server (server.js) as a systemd service.
# Settings are read by server.js from the repository's .env.

set -e

if [ "$EUID" -ne 0 ]; then
    echo "❌ Please run as root: sudo $0"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="${SERVICE_NAME:-webrtc-signaling}"
RUN_AS="${SUDO_USER:-www-data}"
NODE_BIN="$(command -v node)"

echo "🔧 Installing $SERVICE_NAME (user $RUN_AS, dir $SCRIPT_DIR)"

cat > "/etc/systemd/system/${SERVICE_NAME}.service" << UNIT
[Unit]
Description=WebRTC signaling server (PeerJS + TURN credentials)
After=network.target

[Service]
Type=simple
User=$RUN_AS
WorkingDirectory=$SCRIPT_DIR
ExecStart=$NODE_BIN $SCRIPT_DIR/server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

echo ""
echo "✅ $SERVICE_NAME running."
echo "   Status:  systemctl status $SERVICE_NAME"
echo "   Logs:    journalctl -u $SERVICE_NAME -f"
echo ""
echo "Proxy https://<APP_DOMAIN>/peerjs/* to 127.0.0.1:<PORT> (see config-samples/)."
