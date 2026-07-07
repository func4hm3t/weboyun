/* =====================================================================
   ARENA.IO server — authoritative real-time simulation over WebSocket,
   plus a static file server for the client. Run: node server.js
   ===================================================================== */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

/* ---------------- game constants (mirror the client) ---------------- */
const GRID = 90;
const SPEED = 5.6;                 // cells per second
const KILL_BONUS = 300;
const PROTECT_MS = 2000;
const BOOST_MULT = 2;
const BOOST_DRAIN = 34;
const BOOST_REGEN = 13;
const TICK_MS = 50;                // 20 Hz simulation + broadcast
const TOTAL_TARGET = 7;            // bots fill up to this many players
const MAX_HUMANS = 16;

const DIRS = [
  { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }
];
const PALETTE = ['#f97316', '#10b981', '#ec4899', '#8b5cf6', '#ef4444',
  '#14b8a6', '#f59e0b', '#84cc16', '#0ea5e9', '#2563eb'];
const BOT_NAMES = [
  'KingSlayer', 'PixelNinja', 'NeonRider', 'VoidWalker', 'TurboFox',
  'GhostByte', 'MegaBlock', 'ZapZone', 'IronGrid', 'CosmoCat'
];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const isReverse = (a, b) => a.x === -b.x && a.y === -b.y;
const sameDir = (a, b) => a.x === b.x && a.y === b.y;
const normDir = d => DIRS.find(k => sameDir(k, d));
const rotate = (d, sign) => sign === 1 ? { x: -d.y, y: d.x } : { x: d.y, y: -d.x };

/* ---------------- world state ---------------- */
const owner = new Int16Array(GRID * GRID).fill(-1);
const trailMap = new Int16Array(GRID * GRID).fill(-1);
let ownerDelta = [];               // flat [idx, val, idx, val...]
let trailDelta = [];
const players = new Map();         // id -> player
let nextId = 1;

function setOwner(i, v) { if (owner[i] !== v) { owner[i] = v; ownerDelta.push(i, v); } }
function setTrail(i, v) { if (trailMap[i] !== v) { trailMap[i] = v; trailDelta.push(i, v); } }

function makePlayer(name, color, bot, sock) {
  return {
    id: nextId++, name, color, bot, ws: sock || null,
    alive: false, deadUntil: 0, protectedUntil: 0,
    x: 0, y: 0, cx: 0, cy: 0, tx: 0, ty: 0,
    dir: DIRS[0], queue: [],
    trail: [], cells: 0, kills: 0, maxArea: 0,
    energy: 100, boostHeld: false, boostLock: false,
    // bot brain
    planSteps: 0, turnSign: 1, turnCount: 0, maxOut: 20, returning: false
  };
}

function findSpawn() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const cx = randInt(4, GRID - 5), cy = randInt(4, GRID - 5);
    let free = true;
    for (let y = cy - 3; y <= cy + 3 && free; y++)
      for (let x = cx - 3; x <= cx + 3; x++)
        if (owner[y * GRID + x] !== -1 || trailMap[y * GRID + x] !== -1) { free = false; break; }
    if (free) return { cx, cy };
  }
  return { cx: randInt(4, GRID - 5), cy: randInt(4, GRID - 5) };
}

function spawn(p) {
  const s = findSpawn();
  p.cx = s.cx; p.cy = s.cy;
  p.x = p.cx; p.y = p.cy;
  p.trail = []; p.queue = [];
  p.alive = true;
  p.protectedUntil = Date.now() + PROTECT_MS;
  p.energy = 100; p.boostHeld = false; p.boostLock = false;
  p.returning = false; p.turnCount = 0; p.planSteps = 0;
  p.maxArea = 0;
  for (let y = p.cy - 1; y <= p.cy + 1; y++)
    for (let x = p.cx - 1; x <= p.cx + 1; x++)
      setOwner(y * GRID + x, p.id);
  p.dir = p.cx < GRID / 2 ? DIRS[0] : DIRS[1];
  p.tx = p.cx + p.dir.x; p.ty = p.cy + p.dir.y;
}

/* ---------------- rules ---------------- */
function countCells() {
  for (const p of players.values()) p.cells = 0;
  for (let i = 0; i < owner.length; i++) {
    const p = players.get(owner[i]);
    if (p) p.cells++;
  }
}

const score = p => p.cells + p.kills * KILL_BONUS;

function kill(victim, killer) {
  if (!victim || !victim.alive) return;
  if (killer !== null && victim.protectedUntil > Date.now()) return; // shielded

  victim.alive = false;

  // final stats for a human BEFORE the land changes hands
  if (!victim.bot && victim.ws) {
    let cells = 0;
    const counts = new Map();
    for (let i = 0; i < owner.length; i++) {
      const o = owner[i];
      if (o !== -1) counts.set(o, (counts.get(o) || 0) + 1);
    }
    for (const p of players.values()) p.cells = counts.get(p.id) || 0;
    cells = victim.cells;
    const finalScore = cells + victim.kills * KILL_BONUS;
    const area = Math.max(victim.maxArea, cells / (GRID * GRID) * 100);
    const ranked = [...players.values()].sort((a, b) => score(b) - score(a));
    const rank = ranked.indexOf(victim) + 1;
    send(victim.ws, { t: 'dead', s: finalScore, r: rank, a: +area.toFixed(1) });
  }

  for (const idx of victim.trail) if (trailMap[idx] === victim.id) setTrail(idx, -1);
  victim.trail = [];

  const absorb = killer && killer !== victim && killer.alive;
  let gained = 0;
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] === victim.id) {
      setOwner(i, absorb ? killer.id : -1);
      if (absorb) gained++;
    }
  }

  if (killer && killer !== victim) killer.kills++;
  broadcast({
    t: 'kill',
    ki: killer ? killer.id : -1,
    vi: victim.id, vn: victim.name,
    g: gained
  });

  if (victim.bot) victim.deadUntil = Date.now() + randInt(2500, 5000);
}

function capture(p) {
  for (const idx of p.trail) {
    setOwner(idx, p.id);
    if (trailMap[idx] === p.id) setTrail(idx, -1);
  }
  p.trail = [];

  const visited = new Uint8Array(GRID * GRID);
  const stack = [];
  for (let i = 0; i < GRID; i++) {
    const edges = [i, i * GRID, (GRID - 1) * GRID + i, i * GRID + GRID - 1];
    for (const e of edges) if (!visited[e] && owner[e] !== p.id) { visited[e] = 1; stack.push(e); }
  }
  while (stack.length) {
    const idx = stack.pop();
    const x = idx % GRID, y = (idx / GRID) | 0;
    if (x > 0)        { const n = idx - 1;    if (!visited[n] && owner[n] !== p.id) { visited[n] = 1; stack.push(n); } }
    if (x < GRID - 1) { const n = idx + 1;    if (!visited[n] && owner[n] !== p.id) { visited[n] = 1; stack.push(n); } }
    if (y > 0)        { const n = idx - GRID; if (!visited[n] && owner[n] !== p.id) { visited[n] = 1; stack.push(n); } }
    if (y < GRID - 1) { const n = idx + GRID; if (!visited[n] && owner[n] !== p.id) { visited[n] = 1; stack.push(n); } }
  }
  const captured = [];
  for (let i = 0; i < owner.length; i++) {
    if (!visited[i] && owner[i] !== p.id) { setOwner(i, p.id); captured.push(i); }
  }
  if (captured.length) broadcast({ t: 'cap', i: p.id, cs: captured });
}

function onArrive(p) {
  const { cx, cy } = p;
  if (cx < 0 || cy < 0 || cx >= GRID || cy >= GRID) { kill(p, null); return; }
  const idx = cy * GRID + cx;

  const t = trailMap[idx];
  if (t !== -1) {
    const victim = players.get(t);
    if (victim === p) { kill(p, p); return; }
    kill(victim, p);
  }

  if (owner[idx] === p.id) {
    if (p.trail.length) capture(p);
  } else {
    p.trail.push(idx);
    setTrail(idx, p.id);
  }
}

function chooseNext(p) {
  if (!p.bot) {
    while (p.queue.length) {
      const d = p.queue.shift();
      if (!isReverse(d, p.dir) && d !== p.dir) { p.dir = d; break; }
    }
  } else {
    p.dir = botThink(p);
  }
  p.tx = p.cx + p.dir.x;
  p.ty = p.cy + p.dir.y;
}

function stepPlayer(p, dt) {
  const boosting = !p.bot && p.boostHeld && !p.boostLock && p.energy > 0;
  const sp = boosting ? SPEED * BOOST_MULT : SPEED;
  let dist = sp * dt;
  let guard = 0;
  while (dist > 0 && p.alive && guard++ < 8) {
    const dx = p.tx - p.x, dy = p.ty - p.y;
    const d = Math.abs(dx) + Math.abs(dy);
    if (d <= dist) {
      p.x = p.tx; p.y = p.ty;
      p.cx = p.tx; p.cy = p.ty;
      dist -= d;
      onArrive(p);
      if (!p.alive) return;
      chooseNext(p);
    } else {
      p.x += Math.sign(dx) * dist;
      p.y += Math.sign(dy) * dist;
      dist = 0;
    }
  }
}

/* ---------------- bot AI (same brain as the offline game) ---------------- */
function cellSafe(p, x, y) {
  if (x < 0 || y < 0 || x >= GRID || y >= GRID) return false;
  return trailMap[y * GRID + x] !== p.id;
}
const dirSafe = (p, d) => cellSafe(p, p.cx + d.x, p.cy + d.y);

function enemyHeadNear(p, radius) {
  for (const q of players.values()) {
    if (q === p || !q.alive) continue;
    if (Math.abs(q.x - p.x) + Math.abs(q.y - p.y) <= radius) return q;
  }
  return null;
}

function nearestOwnCell(p) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] !== p.id) continue;
    const x = i % GRID, y = (i / GRID) | 0;
    const d = Math.abs(x - p.cx) + Math.abs(y - p.cy);
    if (d < bd) { bd = d; best = i; }
  }
  if (best === -1) return null;
  return { x: best % GRID, y: (best / GRID) | 0 };
}

function towards(p, tx, ty, pool) {
  let best = pool[0], bd = Infinity;
  for (const d of pool) {
    const nd = Math.abs(p.cx + d.x - tx) + Math.abs(p.cy + d.y - ty)
      + (d === p.dir ? -0.3 : 0);
    if (nd < bd) { bd = nd; best = d; }
  }
  return best;
}

function botThink(b) {
  const idx = b.cy * GRID + b.cx;
  const home = owner[idx] === b.id;
  const candidates = DIRS.filter(d => !isReverse(d, b.dir));
  let pool = candidates.filter(d => dirSafe(b, d));
  if (!pool.length) pool = candidates;

  const deepSafe = pool.filter(d => cellSafe(b, b.cx + d.x * 2, b.cy + d.y * 2));
  if (deepSafe.length) pool = deepSafe;

  if (b.trail.length < 10) {
    for (const d of pool) {
      const n = (b.cy + d.y) * GRID + (b.cx + d.x);
      const t = trailMap[n];
      if (t !== -1 && t !== b.id && Math.random() < 0.85) return d;
    }
  }

  if (!home || b.trail.length) {
    const threat = enemyHeadNear(b, 6);
    if (threat || b.trail.length >= b.maxOut) b.returning = true;

    if (b.returning) {
      const target = nearestOwnCell(b);
      if (target) return towards(b, target.x, target.y, pool);
      return pick(pool);
    }
    if (--b.planSteps <= 0) {
      b.planSteps = randInt(3, 8);
      b.turnCount++;
      if (b.turnCount >= 3) b.returning = true;
      const turned = normDir(rotate(b.dir, b.turnSign));
      if (turned && pool.includes(turned)) return turned;
      const alt = normDir(rotate(b.dir, -b.turnSign));
      if (alt && pool.includes(alt)) { b.turnSign *= -1; return alt; }
    }
    if (pool.includes(b.dir)) return b.dir;
    return pick(pool);
  }

  b.returning = false; b.turnCount = 0;
  if (b.planSteps <= 0) {
    b.turnSign = Math.random() < 0.5 ? 1 : -1;
    b.planSteps = randInt(4, 9);
    b.maxOut = randInt(16, 34);
  }
  const margin = 6;
  if (b.cx < margin && pool.includes(DIRS[0])) return DIRS[0];
  if (b.cx >= GRID - margin && pool.includes(DIRS[1])) return DIRS[1];
  if (b.cy < margin && pool.includes(DIRS[2])) return DIRS[2];
  if (b.cy >= GRID - margin && pool.includes(DIRS[3])) return DIRS[3];
  if (Math.random() < 0.15) return pick(pool);
  if (pool.includes(b.dir)) return b.dir;
  return pick(pool);
}

/* ---------------- bots management ---------------- */
function humansCount() {
  let n = 0;
  for (const p of players.values()) if (!p.bot) n++;
  return n;
}

function ensureBots() {
  const wantBots = Math.max(1, TOTAL_TARGET - humansCount());
  const bots = [...players.values()].filter(p => p.bot);
  for (let i = bots.length; i < wantBots; i++) {
    const used = new Set([...players.values()].map(p => p.name));
    const name = BOT_NAMES.find(n => !used.has(n)) || 'Bot' + nextId;
    const usedColors = new Set([...players.values()].map(p => p.color));
    const color = PALETTE.find(c => !usedColors.has(c)) || pick(PALETTE);
    const b = makePlayer(name, color, true, null);
    players.set(b.id, b);
    spawn(b);
    broadcast({ t: 'pj', p: serialize(b) }, null);
  }
  while (bots.length > wantBots) {
    const b = bots.pop();
    kill(b, null);
    players.delete(b.id);
    broadcast({ t: 'pl', i: b.id });
  }
}

/* ---------------- serialization ---------------- */
function serialize(p) {
  return {
    i: p.id, n: p.name, c: p.color, b: p.bot ? 1 : 0,
    x: +p.x.toFixed(2), y: +p.y.toFixed(2),
    a: p.alive ? 1 : 0,
    pr: Math.max(0, p.protectedUntil - Date.now()),
    cx: p.cx, cy: p.cy,
    h: p.trail.length ? 1 : 0,
    k: p.kills, cl: p.cells
  };
}

function send(sock, obj) {
  if (sock && sock.readyState === 1) sock.send(JSON.stringify(obj));
}
function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const p of players.values())
    if (p.ws && p.ws.readyState === 1) p.ws.send(s);
}

/* ---------------- tick loop ---------------- */
setInterval(() => {
  const dt = TICK_MS / 1000;
  const now = Date.now();

  for (const p of players.values()) {
    if (p.alive) {
      if (!p.bot) {
        const draining = p.boostHeld && !p.boostLock && p.energy > 0;
        if (draining) {
          p.energy = Math.max(0, p.energy - BOOST_DRAIN * dt);
          if (p.energy === 0) p.boostLock = true;
        } else {
          p.energy = Math.min(100, p.energy + BOOST_REGEN * dt);
          if (p.boostLock && p.energy > 20) p.boostLock = false;
        }
      }
      stepPlayer(p, dt);
    } else if (p.bot && p.deadUntil && now > p.deadUntil) {
      p.deadUntil = 0;
      spawn(p);
    }
  }

  countCells();
  for (const p of players.values()) {
    if (p.alive) p.maxArea = Math.max(p.maxArea, p.cells / (GRID * GRID) * 100);
  }

  // broadcast state (energy is personal, appended per client)
  const state = {
    t: 'st',
    p: [...players.values()].map(p => [
      p.id, +p.x.toFixed(2), +p.y.toFixed(2), p.alive ? 1 : 0,
      Math.max(0, p.protectedUntil - Date.now()),
      p.cx, p.cy, p.trail.length ? 1 : 0, p.kills, p.cells
    ]),
    od: ownerDelta, td: trailDelta
  };
  ownerDelta = []; trailDelta = [];
  for (const p of players.values()) {
    if (!p.ws || p.ws.readyState !== 1) continue;
    state.e = Math.round(p.energy);
    p.ws.send(JSON.stringify(state));
  }
}, TICK_MS);

/* ---------------- static file server ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml'
};

const httpServer = http.createServer((req, res) => {
  let file = req.url.split('?')[0];
  if (file === '/') file = '/index.html';
  const full = path.join(__dirname, path.normalize(file));
  if (!full.startsWith(__dirname)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ---------------- websocket ---------------- */
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', sock => {
  let me = null;

  sock.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }

    if (m.t === 'join' && !me) {
      if (humansCount() >= MAX_HUMANS) { sock.close(); return; }
      const name = String(m.n || 'Player').slice(0, 14) || 'Player';
      const color = /^#[0-9a-f]{6}$/i.test(m.c || '') ? m.c : '#2563eb';
      me = makePlayer(name, color, false, sock);
      players.set(me.id, me);
      spawn(me);
      ensureBots();
      countCells();
      send(sock, {
        t: 'init', id: me.id,
        o: Array.from(owner), tr: Array.from(trailMap),
        p: [...players.values()].map(serialize)
      });
      broadcastExcept(me, { t: 'pj', p: serialize(me) });
      console.log(`+ ${name} joined (${humansCount()} online)`);
      return;
    }
    if (!me) return;

    if (m.t === 'dir') {
      const d = DIRS[m.d];
      if (d && me.alive) {
        const last = me.queue.length ? me.queue[me.queue.length - 1] : me.dir;
        if (!isReverse(d, last) && d !== last && me.queue.length < 2) me.queue.push(d);
      }
    } else if (m.t === 'boost') {
      me.boostHeld = !!m.on;
    } else if (m.t === 'respawn') {
      if (!me.alive) { spawn(me); me.kills = 0; }
    }
  });

  sock.on('close', () => {
    if (!me) return;
    const p = me; me = null;
    if (p.alive) kill(p, null);
    players.delete(p.id);
    broadcast({ t: 'pl', i: p.id });
    ensureBots();
    console.log(`- ${p.name} left (${humansCount()} online)`);
  });
});

function broadcastExcept(exclude, obj) {
  const s = JSON.stringify(obj);
  for (const p of players.values())
    if (p !== exclude && p.ws && p.ws.readyState === 1) p.ws.send(s);
}

ensureBots();   // arena starts alive with bots

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`ARENA.IO live server → http://localhost:${PORT}`);
});
