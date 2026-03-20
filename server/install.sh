#!/bin/bash

# Installation script for PeerJS Server

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "🔧 Installing PeerJS Server..."
echo ""

# Check if node is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed!"
    echo "   Install Node.js first: curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - && sudo apt-get install -y nodejs"
    exit 1
fi

echo "✓ Node.js version: $(node --version)"
echo "✓ NPM version: $(npm --version)"
echo ""

# Install dependencies
cd "$SCRIPT_DIR"
echo "📦 Installing dependencies..."
npm install

echo ""
echo "✅ Installation complete!"
echo ""
echo "📝 Next steps:"
echo "   1. Start the server: npm start"
echo "   2. Or install as systemd service: sudo ./install-service.sh"
echo ""
