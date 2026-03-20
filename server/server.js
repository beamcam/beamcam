#!/usr/bin/env node

/**
 * PeerJS Server for BeamCam
 * Modern signaling server for WebRTC peer-to-peer connections
 * Using peerjs-server (official package)
 */

const { PeerServer } = require('peer');

const PORT = process.env.PORT || 9000;
const HOST = process.env.HOST || '127.0.0.1';
const PATH = process.env.PATH_PREFIX || '/';

const server = PeerServer({
  port: PORT,
  path: PATH,
  allow_discovery: false,  // SECURITY: Disable peer enumeration
  proxied: true,
  debug: process.env.NODE_ENV !== 'production'  // Only debug in dev
});

server.on('connection', (client) => {
  console.log(`[${new Date().toISOString()}] Client connected: ${client.id}`);
});

server.on('disconnect', (client) => {
  console.log(`[${new Date().toISOString()}] Client disconnected: ${client.id}`);
});

server.on('message', (client, message) => {
  console.log(`[${new Date().toISOString()}] Message from ${client.getId()}: type=${message.type}, dst=${message.dst}`);
});

console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🎥 BeamCam PeerJS Server                      ║
║                                                           ║
║   Status: Running                                         ║
║   Host:   ${HOST}:${PORT}                                        ║
║   Path:   ${PATH}                                    ║
║                                                           ║
║   Discovery: http://${HOST}:${PORT}${PATH}/peers       ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`);
