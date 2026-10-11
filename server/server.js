#!/usr/bin/env node

/**
 * PeerJS Server for BeamCam
 * Signaling for WebRTC peer-to-peer connections (official `peer` package),
 * plus a TURN credential endpoint so the coturn secret never reaches clients.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { ExpressPeerServer } = require('peer');

const PORT = process.env.PORT || 9000;
const HOST = process.env.HOST || '127.0.0.1';
const PATH = process.env.PATH_PREFIX || '/';

// coturn `use-auth-secret` / `static-auth-secret` (TURN REST API credentials)
const TURN_SECRET_FILE = process.env.TURN_SECRET_FILE || path.join(__dirname, '.turn-secret');
const TURN_SECRET = (process.env.TURN_SECRET || fs.readFileSync(TURN_SECRET_FILE, 'utf8')).trim();
const TURN_HOST = process.env.TURN_HOST || 'beamcam.live';
const TURN_TTL = parseInt(process.env.TURN_TTL || '86400', 10); // covers a night-long session
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://beamcam.live').split(',');

const app = express();
app.set('trust proxy', true);
const server = http.createServer(app);

// Naive per-IP rate limit for credential requests: 30 per 10 minutes
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 30;
const hits = new Map();
setInterval(() => hits.clear(), RATE_WINDOW_MS).unref();

app.get(path.posix.join(PATH, 'turn'), (req, res) => {
  res.set('Cache-Control', 'no-store');

  // Browsers send Origin on cross-site requests: refuse other sites leeching
  // our relay. (Non-browser clients can lie; the rate limit and short-lived
  // credentials are what bound the damage.)
  const origin = req.get('origin');
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ error: 'origin not allowed' });
  }

  const count = (hits.get(req.ip) || 0) + 1;
  hits.set(req.ip, count);
  if (count > RATE_MAX) {
    return res.status(429).json({ error: 'too many requests' });
  }

  // username = expiry timestamp, password = base64(HMAC-SHA1(secret, username))
  const username = `${Math.floor(Date.now() / 1000) + TURN_TTL}:beamcam`;
  const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');

  res.json({
    ttl: TURN_TTL,
    iceServers: [
      { urls: `stun:${TURN_HOST}:3478` },
      {
        urls: [
          `turn:${TURN_HOST}:3478?transport=udp`,
          `turn:${TURN_HOST}:3478?transport=tcp`
        ],
        username,
        credential
      }
    ]
  });
});

const peerServer = ExpressPeerServer(server, {
  path: PATH,
  allow_discovery: false,  // SECURITY: Disable peer enumeration
  proxied: true,
  debug: process.env.NODE_ENV !== 'production'  // Only debug in dev
});
app.use('/', peerServer);

peerServer.on('connection', (client) => {
  console.log(`[${new Date().toISOString()}] Client connected: ${client.getId()}`);
});

peerServer.on('disconnect', (client) => {
  console.log(`[${new Date().toISOString()}] Client disconnected: ${client.getId()}`);
});

server.listen(PORT, HOST, () => {
  console.log(`BeamCam PeerJS server listening on ${HOST}:${PORT}, path ${PATH}, TURN credentials at ${path.posix.join(PATH, 'turn')}`);
});
