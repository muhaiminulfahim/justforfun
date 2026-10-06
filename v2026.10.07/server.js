'use strict';
/*
 * Mini Multiplayer Car Game - relay server
 *
 *  - Serves index.html (the game / host screen) and controller.html (phone joystick).
 *  - Keeps "rooms". The browser that shows the game is the HOST of a room.
 *    Phones that open the invite link are PLAYERS in that room.
 *  - It only relays small JSON messages: player input -> host, host state -> players.
 *    The game itself runs entirely in the host's browser.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = 12;              // remote players per room
const MAX_ROOMS = 500;
const HOST_GRACE_MS = 2 * 60 * 1000; // keep a room alive this long if the host tab reloads / drops

/* ---------- static files (whitelist, no directory traversal possible) ---------- */
const FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/controller.html': 'controller.html',
};
const MIME = { '.html': 'text/html; charset=utf-8' };

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      out.push({ name, ip: a.address });
    }
  }
  const rank = ip =>
    ip.startsWith('192.168.') ? 0 :
    ip.startsWith('10.') ? 1 :
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
  return out.sort((a, b) => rank(a.ip) - rank(b.ip));
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
  const p = url.pathname;

  if (p === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ips: lanAddresses(), port: PORT }));
  }

  if (p === '/api/qr') {
    const text = url.searchParams.get('text') || '';
    if (!text || text.length > 400) { res.writeHead(400); return res.end('bad request'); }
    try {
      const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
      return res.end(svg);
    } catch {
      res.writeHead(500); return res.end();
    }
  }

  // Invite link: /j/ABCDE  ->  phone controller
  let file = FILES[p];
  if (!file && /^\/j\/[A-Za-z0-9]{1,12}\/?$/.test(p)) file = 'controller.html';
  if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }

  fs.readFile(path.join(__dirname, file), (err, data) => {
    if (err) { res.writeHead(500, { 'Content-Type': 'text/plain' }); return res.end('Server error'); }
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

/* ---------- rooms over WebSocket ---------- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
const rooms = new Map(); // code -> { code, key, host, players: Map(pid -> {ws,name}), timer }

const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alike characters
function makeCode() {
  let c;
  do {
    c = Array.from({ length: 5 }, () => ALPHA[crypto.randomInt(ALPHA.length)]).join('');
  } while (rooms.has(c));
  return c;
}
const makeKey = () => crypto.randomBytes(16).toString('hex');
const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const clamp1 = v => (typeof v === 'number' && isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.role = null; ws.room = null; ws.pid = null;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m && typeof m === 'object') handle(ws, m);
  });
  ws.on('close', () => onClose(ws));
  ws.on('error', () => {});
});

function handle(ws, m) {
  switch (m.t) {
    case 'host': return onHost(ws, m);
    case 'join': return onJoin(ws, m);

    case 'input': { // player -> host
      if (ws.role !== 'player') return;
      const room = rooms.get(ws.room);
      if (room) send(room.host, { t: 'input', pid: ws.pid, x: clamp1(m.x), y: clamp1(m.y), n: m.n ? 1 : 0 });
      return;
    }
    case 'to': { // host -> one player
      if (ws.role !== 'host') return;
      const room = rooms.get(ws.room);
      const p = room && room.players.get(String(m.pid));
      if (p && m.data && typeof m.data === 'object') send(p.ws, m.data);
      return;
    }
    case 'all': { // host -> every player
      if (ws.role !== 'host') return;
      const room = rooms.get(ws.room);
      if (room && m.data && typeof m.data === 'object') for (const p of room.players.values()) send(p.ws, m.data);
      return;
    }
    case 'kick': { // host removes a player
      if (ws.role !== 'host') return;
      const room = rooms.get(ws.room);
      const pid = String(m.pid);
      const p = room && room.players.get(pid);
      if (p) {
        room.players.delete(pid);
        p.ws.role = null;
        send(p.ws, { t: 'kicked' });
        try { p.ws.close(4003, 'kicked'); } catch {}
      }
      return;
    }
  }
}

function onHost(ws, m) {
  if (ws.role) return;
  let room;
  if (m.room) { // resume after reload / network drop
    room = rooms.get(String(m.room));
    if (!room || room.key !== m.key) return send(ws, { t: 'error', code: 'no-room', msg: 'Room expired' });
    if (room.host && room.host !== ws) {
      const old = room.host;
      old.role = null;
      try { old.close(4000, 'replaced'); } catch {}
    }
  } else {
    if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', code: 'busy', msg: 'Server busy, try again soon' });
    room = { code: makeCode(), key: makeKey(), host: null, players: new Map(), timer: null };
    rooms.set(room.code, room);
  }
  clearTimeout(room.timer);
  room.timer = null;
  room.host = ws;
  ws.role = 'host';
  ws.room = room.code;
  send(ws, { t: 'room', code: room.code, key: room.key, max: MAX_PLAYERS });
  // let a resumed host rebuild the cars of everyone still connected
  for (const [pid, p] of room.players) {
    send(ws, { t: 'join', pid, name: p.name });
    send(p.ws, { t: 'hostonline' });
  }
}

function onJoin(ws, m) {
  if (ws.role) return;
  const room = rooms.get(String(m.room || '').toUpperCase());
  if (!room) return send(ws, { t: 'error', code: 'no-room', msg: 'This invite link is no longer valid.' });
  const pid = String(m.pid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  if (!pid) return;
  const name = String(m.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14);
  const existing = room.players.get(pid);
  if (!existing && room.players.size >= MAX_PLAYERS) {
    return send(ws, { t: 'error', code: 'full', msg: 'This game is full.' });
  }
  if (existing) { // same phone reconnecting: drop the stale socket
    existing.ws.role = null;
    try { existing.ws.close(4001, 'replaced'); } catch {}
  }
  ws.role = 'player';
  ws.room = room.code;
  ws.pid = pid;
  room.players.set(pid, { ws, name });
  send(ws, { t: 'joined', hostOnline: !!(room.host && room.host.readyState === 1) });
  send(room.host, { t: 'join', pid, name });
}

function onClose(ws) {
  const room = ws.room && rooms.get(ws.room);
  if (!room) return;
  if (ws.role === 'host' && room.host === ws) {
    room.host = null;
    for (const p of room.players.values()) send(p.ws, { t: 'hostoffline' });
    room.timer = setTimeout(() => closeRoom(room), HOST_GRACE_MS);
  } else if (ws.role === 'player') {
    const cur = room.players.get(ws.pid);
    if (cur && cur.ws === ws) {
      room.players.delete(ws.pid);
      send(room.host, { t: 'leave', pid: ws.pid });
    }
  }
}

function closeRoom(room) {
  for (const p of room.players.values()) {
    send(p.ws, { t: 'closed' });
    p.ws.role = null;
    try { p.ws.close(4002, 'closed'); } catch {}
  }
  rooms.delete(room.code);
}

// Drop dead connections (phones that went to sleep, Wi-Fi drops...)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 25000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  Mini Multiplayer Car Game is running\n');
  console.log(`  Host screen (open this on the big screen):  http://localhost:${PORT}`);
  for (const a of lanAddresses()) console.log(`  Same network:                               http://${a.ip}:${PORT}   (${a.name})`);
  console.log('\n  Click "Invite players" in the game to get an invite link + QR code.\n');
});
