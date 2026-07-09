/* =====================================================================
   ARENA.IO server — authoritative real-time simulation over WebSocket,
   plus a static file server for the client.
   Run: npm install && node server.js
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

const POWERUP_TYPES = {
  speed:  { dur: 5000 },
  shield: { dur: 7000 },
  bomb:   { dur: 0 },
  energy: { dur: 0 }
};
const POWERUP_KEYS = Object.keys(POWERUP_TYPES);
const POWERUP_INTERVAL = 5000;     // ms between spawns
const POWERUP_MAX = 6;
const POWERUP_LIFE = 20000;

const COMBO_WINDOW = 4000;         // ms between kills to keep a streak alive
const COMBO_BONUS = 150;

// bot personalities: hunters chase kills, farmers grow quietly, expanders carve huge loops
const PERSONAS = {
  hunter:   { tag: '⚔️', maxOutMin: 20, maxOutMax: 40, threat: 4, killChance: 0.98, planMin: 4, planMax: 10 },
  farmer:   { tag: '🌾', maxOutMin: 10, maxOutMax: 18, threat: 9, killChance: 0.5,  planMin: 3, planMax: 6 },
  expander: { tag: '🗺️', maxOutMin: 28, maxOutMax: 50, threat: 6, killChance: 0.75, planMin: 6, planMax: 12 }
};
const PERSONA_KEYS = Object.keys(PERSONAS);

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

/* ---------------- room state ---------------- */
let owner = new Int16Array(GRID * GRID).fill(-1);
let trailMap = new Int16Array(GRID * GRID).fill(-1);
let ownerDelta = [];               // flat [idx, val, idx, val...]
let trailDelta = [];
let players = new Map();           // id -> player
let nextId = 1;
let powerups = [];                 // {id, cx, cy, type, born}
let nextPuId = 1;
let lastPuSpawn = 0;
let personaCursor = 0;
const rooms = new Map();

function cleanRoomId(v) {
  return String(v || 'public').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24) || 'public';
}

function roomTitle(v) {
  return String(v || 'public').trim().slice(0, 24) || 'public';
}

function makeRoom(id, label, password) {
  return {
    id, label,
    password: String(password || ''),
    owner: new Int16Array(GRID * GRID).fill(-1),
    trailMap: new Int16Array(GRID * GRID).fill(-1),
    ownerDelta: [], trailDelta: [],
    players: new Map(),
    nextId: 1,
    powerups: [],
    nextPuId: 1,
    lastPuSpawn: 0,
    personaCursor: 0
  };
}

function useRoom(room) {
  owner = room.owner;
  trailMap = room.trailMap;
  ownerDelta = room.ownerDelta;
  trailDelta = room.trailDelta;
  players = room.players;
  nextId = room.nextId;
  powerups = room.powerups;
  nextPuId = room.nextPuId;
  lastPuSpawn = room.lastPuSpawn;
  personaCursor = room.personaCursor;
}

function saveRoom(room) {
  room.owner = owner;
  room.trailMap = trailMap;
  room.ownerDelta = ownerDelta;
  room.trailDelta = trailDelta;
  room.players = players;
  room.nextId = nextId;
  room.powerups = powerups;
  room.nextPuId = nextPuId;
  room.lastPuSpawn = lastPuSpawn;
  room.personaCursor = personaCursor;
}

function getOrCreateRoom(rawId, rawPassword) {
  const id = cleanRoomId(rawId);
  const password = String(rawPassword || '').slice(0, 48);
  let room = rooms.get(id);
  if (room) {
    if (room.password && room.password !== password) return { error: 'bad_password' };
    if (!room.password && password) return { error: 'bad_password' };
    return { room };
  }
  room = makeRoom(id, roomTitle(rawId), password);
  rooms.set(id, room);
  useRoom(room);
  ensureBots();
  saveRoom(room);
  return { room };
}

function setOwner(i, v) { if (owner[i] !== v) { owner[i] = v; ownerDelta.push(i, v); } }
function setTrail(i, v) { if (trailMap[i] !== v) { trailMap[i] = v; trailDelta.push(i, v); } }

function makePlayer(name, color, bot, sock) {
  return {
    id: nextId++, name, color, bot, ws: sock || null,
    persona: null,
    alive: false, deadUntil: 0, protectedUntil: 0,
    shieldUntil: 0, speedUntil: 0,
    comboCount: 0, comboLast: 0, bonus: 0,
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
  p.shieldUntil = 0; p.speedUntil = 0;
  p.comboCount = 0; p.comboLast = 0;
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

const score = p => p.cells + p.kills * KILL_BONUS + p.bonus;

function kill(victim, killer) {
  if (!victim || !victim.alive) return;
  if (killer !== null && victim.protectedUntil > Date.now()) return; // spawn shield
  // pickup shield absorbs one lethal hit, then breaks
  if (killer !== null && victim.shieldUntil > Date.now()) {
    victim.shieldUntil = 0;
    broadcast({ t: 'sha', i: victim.id });
    return;
  }

  victim.alive = false;

  // final stats for a human BEFORE the land changes hands
  if (!victim.bot && victim.ws) {
    countCells();
    const finalScore = score(victim);
    const area = Math.max(victim.maxArea, victim.cells / (GRID * GRID) * 100);
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

  let combo = 0;
  if (killer && killer !== victim) {
    killer.kills++;
    const now = Date.now();
    killer.comboCount = now - killer.comboLast < COMBO_WINDOW ? killer.comboCount + 1 : 1;
    killer.comboLast = now;
    if (killer.comboCount >= 2) killer.bonus += (killer.comboCount - 1) * COMBO_BONUS;
    combo = killer.comboCount;
  }
  broadcast({
    t: 'kill',
    ki: killer ? killer.id : -1,
    kn: killer ? killer.name : '',
    vi: victim.id, vn: victim.name,
    g: gained, cb: combo
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

/* ---------------- power-ups ---------------- */
function spawnPowerup() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const cx = randInt(2, GRID - 3), cy = randInt(2, GRID - 3);
    if (trailMap[cy * GRID + cx] !== -1) continue;
    if (powerups.some(u => u.cx === cx && u.cy === cy)) continue;
    const u = { id: nextPuId++, cx, cy, type: pick(POWERUP_KEYS), born: Date.now() };
    powerups.push(u);
    broadcast({ t: 'pua', u: { i: u.id, x: u.cx, y: u.cy, tp: u.type } });
    return;
  }
}

function applyPowerup(p, u) {
  const now = Date.now();
  if (u.type === 'speed') {
    p.speedUntil = now + POWERUP_TYPES.speed.dur;
  } else if (u.type === 'shield') {
    p.shieldUntil = now + POWERUP_TYPES.shield.dur;
  } else if (u.type === 'energy') {
    if (!p.bot) { p.energy = 100; p.boostLock = false; }
    else p.speedUntil = now + 2500;
  } else if (u.type === 'bomb') {
    // instantly claim a 5x5 patch (never eats trail cells — that would corrupt captures)
    const claimed = [];
    for (let y = Math.max(0, p.cy - 2); y <= Math.min(GRID - 1, p.cy + 2); y++)
      for (let x = Math.max(0, p.cx - 2); x <= Math.min(GRID - 1, p.cx + 2); x++) {
        const i = y * GRID + x;
        if (owner[i] !== p.id && trailMap[i] === -1) { setOwner(i, p.id); claimed.push(i); }
      }
    if (claimed.length) broadcast({ t: 'cap', i: p.id, cs: claimed });
  }
  broadcast({ t: 'pur', i: u.id, pi: p.id, tp: u.type });
}

/* ---------------- movement ---------------- */
function onArrive(p) {
  const { cx, cy } = p;
  // walls deflect instead of killing (matches the offline game)
  if (cx < 0 || cy < 0 || cx >= GRID || cy >= GRID) {
    p.cx = clamp(cx, 0, GRID - 1);
    p.cy = clamp(cy, 0, GRID - 1);
    p.x = p.cx;
    p.y = p.cy;
    if (cx < 0) p.dir = DIRS[0];
    else if (cx >= GRID) p.dir = DIRS[1];
    else if (cy < 0) p.dir = DIRS[2];
    else p.dir = DIRS[3];
    p.tx = p.cx + p.dir.x; p.ty = p.cy + p.dir.y;
    return;
  }
  const idx = cy * GRID + cx;

  for (let i = powerups.length - 1; i >= 0; i--) {
    if (powerups[i].cx === cx && powerups[i].cy === cy) {
      applyPowerup(p, powerups.splice(i, 1)[0]);
    }
  }

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
  const fast = boosting || p.speedUntil > Date.now();
  const sp = fast ? SPEED * BOOST_MULT : SPEED;
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
  const P = b.persona || PERSONAS.expander;
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
      if (t !== -1 && t !== b.id && Math.random() < P.killChance) return d;
    }
  }

  if (!home || b.trail.length) {
    const threat = enemyHeadNear(b, P.threat);
    if (threat || b.trail.length >= b.maxOut) b.returning = true;

    if (b.returning) {
      const target = nearestOwnCell(b);
      if (target) return towards(b, target.x, target.y, pool);
      return pick(pool);
    }
    if (--b.planSteps <= 0) {
      b.planSteps = randInt(P.planMin, P.planMax);
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
    b.planSteps = randInt(P.planMin, P.planMax);
    b.maxOut = randInt(P.maxOutMin, P.maxOutMax);
  }
  // hunters stalk the nearest unshielded prey even from home turf
  if (P === PERSONAS.hunter) {
    let prey = null, pd = Infinity;
    for (const q of players.values()) {
      if (q === b || !q.alive || q.protectedUntil > Date.now()) continue;
      const d = Math.abs(q.cx - b.cx) + Math.abs(q.cy - b.cy);
      if (d < pd) { pd = d; prey = q; }
    }
    if (prey && pd < 18 && Math.random() < 0.7) return towards(b, prey.cx, prey.cy, pool);
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
    b.persona = PERSONAS[PERSONA_KEYS[personaCursor++ % PERSONA_KEYS.length]];
    players.set(b.id, b);
    spawn(b);
    broadcast({ t: 'pj', p: serialize(b) });
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
    pt: p.persona ? p.persona.tag : '',
    x: +p.x.toFixed(2), y: +p.y.toFixed(2),
    a: p.alive ? 1 : 0,
    pr: Math.max(0, p.protectedUntil - Date.now()),
    sh: Math.max(0, p.shieldUntil - Date.now()),
    cx: p.cx, cy: p.cy,
    h: p.trail.length ? 1 : 0,
    k: p.kills, cl: p.cells, sc: score(p)
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
function broadcastExcept(exclude, obj) {
  const s = JSON.stringify(obj);
  for (const p of players.values())
    if (p !== exclude && p.ws && p.ws.readyState === 1) p.ws.send(s);
}

/* ---------------- tick loop ---------------- */
setInterval(() => {
  for (const room of rooms.values()) {
  useRoom(room);
  const dt = TICK_MS / 1000;
  const now = Date.now();

  if (now - lastPuSpawn >= POWERUP_INTERVAL && powerups.length < POWERUP_MAX) {
    lastPuSpawn = now;
    spawnPowerup();
  }
  for (let i = powerups.length - 1; i >= 0; i--) {
    if (now - powerups[i].born > POWERUP_LIFE) {
      broadcast({ t: 'pur', i: powerups[i].id, pi: -1, tp: powerups[i].type });
      powerups.splice(i, 1);
    }
  }

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
      Math.max(0, p.protectedUntil - now),
      p.cx, p.cy, p.trail.length ? 1 : 0, p.kills, p.cells,
      score(p), Math.max(0, p.shieldUntil - now)
    ]),
    od: ownerDelta, td: trailDelta
  };
  ownerDelta = []; trailDelta = [];
  for (const p of players.values()) {
    if (!p.ws || p.ws.readyState !== 1) continue;
    state.e = Math.round(p.energy);
    p.ws.send(JSON.stringify(state));
  }
  saveRoom(room);
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
  let room = null;

  sock.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }

    if (m.t === 'join' && !me) {
      const result = getOrCreateRoom(m.r, m.pw);
      if (result.error) {
        send(sock, { t: 'err', code: result.error });
        sock.close();
        return;
      }
      room = result.room;
      useRoom(room);
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
        r: room.label,
        o: Array.from(owner), tr: Array.from(trailMap),
        p: [...players.values()].map(serialize),
        pu: powerups.map(u => ({ i: u.id, x: u.cx, y: u.cy, tp: u.type }))
      });
      broadcastExcept(me, { t: 'pj', p: serialize(me) });
      saveRoom(room);
      console.log(`+ ${name} joined room ${room.id} (${humansCount()} online)`);
      return;
    }
    if (!me) return;
    useRoom(room);

    if (m.t === 'dir') {
      const d = DIRS[m.d];
      if (d && me.alive) {
        const last = me.queue.length ? me.queue[me.queue.length - 1] : me.dir;
        if (!isReverse(d, last) && d !== last && me.queue.length < 2) me.queue.push(d);
      }
    } else if (m.t === 'boost') {
      me.boostHeld = !!m.on;
    } else if (m.t === 'respawn') {
      if (!me.alive) { spawn(me); me.kills = 0; me.bonus = 0; }
    }
    saveRoom(room);
  });

  sock.on('close', () => {
    if (!me) return;
    useRoom(room);
    const p = me; me = null;
    if (p.alive) kill(p, null);
    players.delete(p.id);
    broadcast({ t: 'pl', i: p.id });
    ensureBots();
    saveRoom(room);
    console.log(`- ${p.name} left room ${room.id} (${humansCount()} online)`);
  });
});

getOrCreateRoom('public', '');   // arena starts alive with bots

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`ARENA.IO live server → http://localhost:${PORT}`);
});
