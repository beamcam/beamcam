#!/bin/bash

# Install and configure coturn (STUN/TURN) for NAT traversal.
#
# Reads APP_DOMAIN / TURN_HOST / TURN_PORT from the repository's .env,
# generates a fresh shared secret and writes it to .env as TURN_SECRET
# (read by server/server.js to mint short-lived TURN credentials).

set -e

if [ "$EUID" -ne 0 ]; then
    echo "❌ Please run as root: sudo $0"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$(dirname "$SCRIPT_DIR")/.env"
[ -f "$ENV_FILE" ] || { echo "❌ $ENV_FILE not found: cp .env.example .env first"; exit 1; }

getenv() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | sed 's/[[:space:]]#.*//; s/^"\(.*\)"$/\1/'; }
APP_DOMAIN="$(getenv APP_DOMAIN)"
TURN_HOST="$(getenv TURN_HOST)"; TURN_HOST="${TURN_HOST:-$APP_DOMAIN}"
TURN_PORT="$(getenv TURN_PORT)"; TURN_PORT="${TURN_PORT:-3478}"
[ -n "$APP_DOMAIN" ] || { echo "❌ APP_DOMAIN is empty in $ENV_FILE"; exit 1; }

# Public IP: set EXTERNAL_IP to skip the lookup (it queries ifconfig.me)
EXTERNAL_IP="${EXTERNAL_IP:-$(curl -s https://ifconfig.me)}"

echo "🔧 Installing coturn for $TURN_HOST:$TURN_PORT (public IP $EXTERNAL_IP)"
apt-get update
apt-get install -y coturn
sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
[ -f /etc/turnserver.conf ] && cp /etc/turnserver.conf /etc/turnserver.conf.backup

TURN_SECRET="$(openssl rand -hex 32)"

cat > /etc/turnserver.conf << CONF
# STUN/TURN for peer-to-peer WebRTC ($APP_DOMAIN)
listening-port=$TURN_PORT
external-ip=$EXTERNAL_IP
fingerprint

# TURN REST API credentials: the signaling server signs short-lived
# usernames with this secret, clients never see it
lt-cred-mech
use-auth-secret
static-auth-secret=$TURN_SECRET

server-name=$TURN_HOST
realm=$TURN_HOST

# Relay ports (open them in the firewall, UDP)
min-port=49152
max-port=65535

# Never relay into private networks (remove for a LAN-only install)
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
no-loopback-peers
no-multicast-peers
no-cli

log-file=/var/log/turnserver.log
CONF
chmod 640 /etc/turnserver.conf

# Store the secret in .env for server.js
if grep -qE '^TURN_SECRET=' "$ENV_FILE"; then
    sed -i "s|^TURN_SECRET=.*|TURN_SECRET=$TURN_SECRET|" "$ENV_FILE"
else
    printf '\nTURN_SECRET=%s\n' "$TURN_SECRET" >> "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"
[ -n "$SUDO_USER" ] && chown "$SUDO_USER" "$ENV_FILE"

systemctl enable coturn
systemctl restart coturn

echo ""
echo "✅ coturn running. TURN_SECRET written to $ENV_FILE"
echo ""
echo "Firewall (ufw example):"
echo "   ufw allow $TURN_PORT/udp && ufw allow $TURN_PORT/tcp && ufw allow 49152:65535/udp"
echo "Then restart the signaling server so it picks up the new secret."
