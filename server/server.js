#!/usr/bin/env node

/**
 * Signaling server: WebRTC peer-to-peer connections (official `peer` package),
 * plus a TURN credential endpoint so the coturn secret never reaches clients.
 *
 * Settings come from the environment, or from the repository's .env file
 * (real environment variables win).
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { ExpressPeerServer } = require('peer');

// Minimal .env reader (KEY=VALUE lines): no dependency, never overrides the
// real environment
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m || m[1] in process.env) continue;
    let val = m[2].replace(/\s+#.*$/, '').trim();
    if (/^(["']).*\1$/.test(val)) val = val.slice(1, -1);
    process.env[m[1]] = val;
  }
}
loadEnv(path.join(__dirname, '..', '.env'));
loadEnv(path.join(__dirname, '.env'));

const env = (key, fallback) => process.env[key] || fallback;

const APP_DOMAIN = env('APP_DOMAIN', 'localhost');
const PORT = env('PORT', 9000);
const HOST = env('HOST', '127.0.0.1');
const PATH = env('PATH_PREFIX', env('SIGNALING_PATH', '/'));

// coturn `use-auth-secret` / `static-auth-secret` (TURN REST API credentials)
const TURN_SECRET_FILE = env('TURN_SECRET_FILE', path.join(__dirname, '.turn-secret'));
const TURN_SECRET = (process.env.TURN_SECRET ||
  (fs.existsSync(TURN_SECRET_FILE) ? fs.readFileSync(TURN_SECRET_FILE, 'utf8') : '')).trim();
if (!TURN_SECRET) {
  console.error('TURN_SECRET is not set (in .env, the environment, or TURN_SECRET_FILE). Refusing to start.');
  process.exit(1);
}
const TURN_HOST = env('TURN_HOST', APP_DOMAIN);
const TURN_PORT = env('TURN_PORT', 3478);
const TURN_TTL = parseInt(env('TURN_TTL', '86400'), 10); // covers a night-long session
const ALLOWED_ORIGINS = env('ALLOWED_ORIGINS', `https://${APP_DOMAIN}`).split(',').map((o) => o.trim());

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
  const username = `${Math.floor(Date.now() / 1000) + TURN_TTL}:user`;
  const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');

  res.json({
    ttl: TURN_TTL,
    iceServers: [
      { urls: `stun:${TURN_HOST}:${TURN_PORT}` },
      {
        urls: [
          `turn:${TURN_HOST}:${TURN_PORT}?transport=udp`,
          `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`
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
  console.log(`Signaling server listening on ${HOST}:${PORT}, path ${PATH}, TURN credentials at ${path.posix.join(PATH, 'turn')}`);
});
