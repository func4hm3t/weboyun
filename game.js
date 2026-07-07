/* =====================================================================
   ARENA.IO — a paper.io style territory conquest game
   Pure JS + Canvas, no dependencies.
   ===================================================================== */
'use strict';

/* ---------------- constants ---------------- */
const GRID  = 90;                 // cells per side
const CELL  = 36;                 // world pixels per cell
const WORLD = GRID * CELL;
const SPEED = 5.6;                // cells per second
const BOT_COUNT = 6;
const KILL_BONUS = 300;
const PROTECT_MS = 2000;          // spawn invincibility
const BOOST_MULT = 2;             // speed while boosting
const BOOST_DRAIN = 34;           // energy per second while boosting
const BOOST_REGEN = 13;           // energy per second while idle
const MAP_SIZES = [104, 150, 230]; // minimap diameter presets (px)

const DIRS = [
  { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }
];

const SKINS = ['#2563eb', '#f97316', '#10b981', '#ec4899', '#8b5cf6'];
const EXTRA_SKINS = ['#ef4444', '#14b8a6', '#f59e0b', '#84cc16', '#0ea5e9'];
const ALL_SKINS = SKINS.concat(EXTRA_SKINS);

const BOT_NAMES = [
  'KingSlayer', 'PixelNinja', 'NeonRider', 'VoidWalker', 'TurboFox',
  'GhostByte', 'MegaBlock', 'ZapZone', 'IronGrid', 'CosmoCat'
];

/* ---------------- helpers ---------------- */
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

function shade(hex, f) {
  // f in [-1, 1]: negative darkens, positive lightens
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (f < 0) { r *= 1 + f; g *= 1 + f; b *= 1 + f; }
  else { r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* ---------------- persistent profile ---------------- */
const store = {
  data: null,
  load() {
    try { this.data = JSON.parse(localStorage.getItem('arenaio') || '{}'); }
    catch (e) { this.data = {}; }
    this.data = Object.assign({
      name: '', skin: 0, sound: true, mapSize: 1,
      xp: 0, streak: 0, games: 0, bestScore: 0, bestRank: 0, kills: 0, bestArea: 0
    }, this.data);
  },
  save() { try { localStorage.setItem('arenaio', JSON.stringify(this.data)); } catch (e) {} }
};
store.load();

function levelFromXp(xp) {
  let lvl = 1, need = 300, rest = xp;
  while (rest >= need) { rest -= need; lvl++; need = Math.round(need * 1.18); }
  return { lvl, rest, need };
}

/* ---------------- audio (tiny synth) ---------------- */
const audio = {
  ctx: null,
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  },
  beep(freq, dur, type, vol, slide) {
    if (!store.data.sound) return;
    this.ensure();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(vol || 0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.ctx.destination);
    o.start(t); o.stop(t + dur);
  },
  click()   { this.beep(660, 0.07, 'square', 0.05); },
  capture(sz) { this.beep(420 + Math.min(sz, 200) * 2, 0.16, 'triangle', 0.14, 160); },
  kill()    { this.beep(190, 0.22, 'sawtooth', 0.14, -80); },
  death()   { this.beep(320, 0.5, 'sawtooth', 0.16, -260); },
  start()   { this.beep(520, 0.12, 'triangle', 0.1, 140); }
};

/* =====================================================================
   MENU
   ===================================================================== */
function buildSkinRows() {
  const make = (row, colors, offset) => {
    row.innerHTML = '';
    colors.forEach((c, i) => {
      const idx = offset + i;
      const el = document.createElement('div');
      el.className = 'skin' + (store.data.skin === idx ? ' selected' : '');
      el.innerHTML = `<div class="skin-square" style="background:${c};box-shadow:inset 0 -5px 0 ${rgba(c,0)}, 0 4px 10px ${rgba(c,.35)}"></div><div class="skin-check">✓</div>`;
      el.addEventListener('click', () => {
        store.data.skin = idx; store.save();
        document.querySelectorAll('.skin').forEach(s => s.classList.remove('selected'));
        el.classList.add('selected');
        audio.click();
      });
      row.appendChild(el);
    });
  };
  make($('skin-row'), SKINS, 0);
  make($('skin-row-extra'), EXTRA_SKINS, SKINS.length);
}
buildSkinRows();

$('name-input').value = store.data.name || '';

$('btn-view-all').addEventListener('click', () => {
  const extra = $('skin-row-extra');
  const showing = !extra.classList.contains('hidden');
  extra.classList.toggle('hidden');
  $('btn-view-all').innerHTML = showing
    ? 'View All <span class="arrow">&rarr;</span>'
    : 'Show Less <span class="arrow">&larr;</span>';
  audio.click();
});

/* modals */
function openModal(title, bodyHtml) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = bodyHtml;
  $('modal-backdrop').classList.remove('hidden');
}
$('modal-close').addEventListener('click', () => {
  $('modal-backdrop').classList.add('hidden'); audio.click();
});
$('modal-backdrop').addEventListener('click', e => {
  if (e.target === $('modal-backdrop')) $('modal-backdrop').classList.add('hidden');
});

$('btn-settings').addEventListener('click', () => {
  audio.click();
  openModal('Settings', `
    <div class="modal-row"><span>Sound Effects</span>
      <button class="toggle ${store.data.sound ? 'on' : ''}" id="tgl-sound"></button></div>
    <div class="modal-row"><span>Controls</span><span class="val">WASD / Arrows / Swipe</span></div>
  `);
  $('tgl-sound').addEventListener('click', function () {
    store.data.sound = !store.data.sound; store.save();
    this.classList.toggle('on', store.data.sound);
    audio.click();
  });
});

$('btn-stats').addEventListener('click', () => {
  audio.click();
  const L = levelFromXp(store.data.xp);
  openModal('Career Stats', `
    <div class="modal-row"><span>Level</span><span class="val">${L.lvl}</span></div>
    <div class="modal-row"><span>Total XP</span><span class="val">${store.data.xp.toLocaleString()}</span></div>
    <div class="modal-row"><span>Games Played</span><span class="val">${store.data.games}</span></div>
    <div class="modal-row"><span>Best Score</span><span class="val">${store.data.bestScore.toLocaleString()}</span></div>
    <div class="modal-row"><span>Best Rank</span><span class="val">${store.data.bestRank ? '#' + store.data.bestRank : '—'}</span></div>
    <div class="modal-row"><span>Max Area Claimed</span><span class="val">${store.data.bestArea.toFixed(1)}%</span></div>
    <div class="modal-row"><span>Total Kills</span><span class="val">${store.data.kills}</span></div>
    <div class="modal-row"><span>Win Streak</span><span class="val">🔥 ${store.data.streak}</span></div>
  `);
});

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._tm);
  t._tm = setTimeout(() => t.classList.add('hidden'), 2200);
}

/* =====================================================================
   GAME STATE
   ===================================================================== */
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const mmCanvas = $('minimap');
const mmCtx = mmCanvas.getContext('2d');
const mmBuf = document.createElement('canvas');
mmBuf.width = GRID; mmBuf.height = GRID;
const mmBufCtx = mmBuf.getContext('2d');

let owner, trailMap;              // Int16Array per cell: player id or -1
let players = [];
let human = null;
let running = false;
let boostHeld = false, boostLock = false, boostActive = false;
let camX = 0, camY = 0;
let particles = [];
let flashes = [];                 // capture flash: {cells:[], t}
let lastTime = 0;
let hudTimer = 0, mmDirty = true;
let deathHandled = false;

function resize() {
  canvas.width = window.innerWidth * devicePixelRatio;
  canvas.height = window.innerHeight * devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}
window.addEventListener('resize', resize);

/* ---------------- players ---------------- */
function makePlayer(id, name, color, isHuman) {
  return {
    id, name, color, isHuman,
    dark: shade(color, -0.28),
    alive: false, deadUntil: 0, protectedUntil: 0, energy: 100,
    x: 0, y: 0, cx: 0, cy: 0, tx: 0, ty: 0,
    dir: DIRS[0], queue: [],
    trail: [], cells: 0, kills: 0,
    // bot brain
    planSteps: 0, turnSign: 1, turnCount: 0, maxOut: 20,
    returning: false, homeX: 0, homeY: 0
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
  p.homeX = p.cx; p.homeY = p.cy;
  p.trail = []; p.queue = [];
  p.alive = true;
  p.protectedUntil = performance.now() + PROTECT_MS;
  p.returning = false; p.turnCount = 0; p.planSteps = 0;
  for (let y = p.cy - 1; y <= p.cy + 1; y++)
    for (let x = p.cx - 1; x <= p.cx + 1; x++)
      owner[y * GRID + x] = p.id;
  // head to the side with most space
  p.dir = p.cx < GRID / 2 ? DIRS[0] : DIRS[1];
  p.tx = p.cx + p.dir.x; p.ty = p.cy + p.dir.y;
  mmDirty = true;
}

function startGame() {
  const name = $('name-input').value.trim() || 'Player One';
  store.data.name = name; store.save();

  owner = new Int16Array(GRID * GRID).fill(-1);
  trailMap = new Int16Array(GRID * GRID).fill(-1);
  players = [];
  particles = []; flashes = [];
  deathHandled = false;

  const humanColor = ALL_SKINS[store.data.skin] || SKINS[0];
  human = makePlayer(0, name, humanColor, true);
  players.push(human);

  const botColors = ALL_SKINS.filter(c => c !== humanColor);
  const names = BOT_NAMES.slice();
  for (let i = 0; i < BOT_COUNT; i++) {
    const nm = names.splice(Math.floor(Math.random() * names.length), 1)[0];
    players.push(makePlayer(i + 1, nm, botColors[i % botColors.length], false));
  }
  players.forEach(spawn);

  camX = human.x * CELL - window.innerWidth / 2;
  camY = human.y * CELL - window.innerHeight / 2;

  $('hpc-name').textContent = name;
  $('hpc-swatch').style.background = humanColor;
  $('hpc-bar-fill').style.background = humanColor;

  human.energy = 100;
  boostHeld = false; boostLock = false; boostActive = false;

  $('menu').classList.add('hidden');
  $('gameover').classList.add('hidden');
  $('game').classList.remove('hidden');
  $('game-settings-panel').classList.add('hidden');
  applyMapSize();
  resize();

  running = true;
  lastTime = performance.now();
  audio.ensure(); audio.start();
  updateHud();
  requestAnimationFrame(loop);
}

/* ---------------- core rules ---------------- */
function countCells() {
  players.forEach(p => p.cells = 0);
  for (let i = 0; i < owner.length; i++) {
    const o = owner[i];
    if (o !== -1 && players[o]) players[o].cells++;
  }
}

function score(p) { return p.cells + p.kills * KILL_BONUS; }
function areaPct(p) { return p.cells / (GRID * GRID) * 100; }

function burst(x, y, color, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 240;
    particles.push({
      x: x * CELL + CELL / 2, y: y * CELL + CELL / 2,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: 0.6 + Math.random() * 0.5, t: 0,
      size: 4 + Math.random() * 8, color
    });
  }
}

function kill(victim, killer) {
  if (!victim || !victim.alive) return;
  // spawn protection blocks trail kills (walls — killer === null — still kill)
  if (killer !== null && victim.protectedUntil > performance.now()) {
    if (killer && killer.isHuman && killer !== victim) toast(`${victim.name} is shielded!`);
    return;
  }
  victim.alive = false;
  burst(victim.x, victim.y, victim.color, 26);

  // capture the human's final stats BEFORE the territory changes hands
  let pendingEnd = null;
  if (victim.isHuman && !deathHandled) {
    deathHandled = true;
    countCells();
    const finalScore = score(victim);
    const finalArea = Math.max(victim._maxArea || 0, areaPct(victim));
    const ranked = players.slice().sort((a, b) => score(b) - score(a));
    const rank = ranked.indexOf(victim) + 1;
    pendingEnd = () => endGame(finalScore, rank, finalArea);
  }

  // trail evaporates
  for (const idx of victim.trail) if (trailMap[idx] === victim.id) trailMap[idx] = -1;
  victim.trail = [];

  // territory: the killer absorbs it; with no killer it evaporates
  const absorb = killer && killer !== victim && killer.alive;
  const gained = [];
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] === victim.id) {
      owner[i] = absorb ? killer.id : -1;
      if (absorb) gained.push(i);
    }
  }
  if (absorb && gained.length) flashes.push({ cells: gained, t: 0, color: killer.color });
  mmDirty = true;

  if (killer && killer !== victim) {
    killer.kills++;
    if (killer.isHuman) {
      audio.kill();
      toast(`You eliminated ${victim.name}! +${KILL_BONUS}${gained.length ? ` and claimed ${gained.length} cells` : ''}`);
    }
  }
  if (victim.isHuman) {
    audio.death();
    if (pendingEnd) setTimeout(pendingEnd, 900);
  } else {
    victim.deadUntil = performance.now() + randInt(2500, 5000);
  }
}

function capture(p) {
  // 1) trail becomes territory
  for (const idx of p.trail) {
    owner[idx] = p.id;
    if (trailMap[idx] === p.id) trailMap[idx] = -1;
  }
  const gainedTrail = p.trail.length;
  p.trail = [];

  // 2) flood fill from map borders across everything NOT owned by p;
  //    whatever is unreachable is enclosed -> becomes p's territory
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
    if (!visited[i] && owner[i] !== p.id) { owner[i] = p.id; captured.push(i); }
  }
  if (captured.length || gainedTrail) {
    flashes.push({ cells: captured, t: 0, color: p.color });
    if (p.isHuman) audio.capture(captured.length + gainedTrail);
    mmDirty = true;
  }
  p.homeX = p.cx; p.homeY = p.cy;
}

function onArrive(p) {
  const { cx, cy } = p;
  if (cx < 0 || cy < 0 || cx >= GRID || cy >= GRID) {
    if (p.isHuman) toast('You hit the wall!');
    kill(p, null);
    return;
  }
  const idx = cy * GRID + cx;

  // stepping on a trail kills the trail's owner (yourself included)
  const t = trailMap[idx];
  if (t !== -1) {
    const victim = players[t];
    if (victim === p) { kill(p, p); return; }
    kill(victim, p);
  }

  if (owner[idx] === p.id) {
    if (p.trail.length) capture(p);
  } else {
    p.trail.push(idx);
    trailMap[idx] = p.id;
  }
}

const isReverse = (a, b) => a.x === -b.x && a.y === -b.y;

function chooseNext(p) {
  if (p.isHuman) {
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
  const sp = p.isHuman && boostActive ? SPEED * BOOST_MULT : SPEED;
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

/* ---------------- bot AI ---------------- */
function cellSafe(p, x, y) {
  if (x < 0 || y < 0 || x >= GRID || y >= GRID) return false;
  return trailMap[y * GRID + x] !== p.id;    // own trail = suicide
}

function dirSafe(p, d) {
  // one step must be safe; two steps ahead being safe is a bonus checked separately
  return cellSafe(p, p.cx + d.x, p.cy + d.y);
}

function enemyHeadNear(p, radius) {
  for (const q of players) {
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
      + (d === p.dir ? -0.3 : 0);                 // slight momentum bias
    if (nd < bd) { bd = nd; best = d; }
  }
  return best;
}

function rotate(d, sign) {
  // sign 1 = clockwise
  return sign === 1 ? { x: -d.y, y: d.x } : { x: d.y, y: -d.x };
}
function sameDir(a, b) { return a.x === b.x && a.y === b.y; }
function normDir(d) { return DIRS.find(k => sameDir(k, d)); }

function botThink(b) {
  const idx = b.cy * GRID + b.cx;
  const home = owner[idx] === b.id;
  const candidates = DIRS.filter(d => !isReverse(d, b.dir));
  let pool = candidates.filter(d => dirSafe(b, d));
  if (!pool.length) pool = candidates;          // cornered — accept fate

  // prefer directions that are also safe 2 cells ahead (don't box yourself)
  const deepSafe = pool.filter(d => cellSafe(b, b.cx + d.x * 2, b.cy + d.y * 2));
  if (deepSafe.length) pool = deepSafe;

  // opportunistic kill: enemy trail right next to us and our trail is short
  if (b.trail.length < 10) {
    for (const d of pool) {
      const n = (b.cy + d.y) * GRID + (b.cx + d.x);
      const t = trailMap[n];
      if (t !== -1 && t !== b.id && Math.random() < 0.85) return d;
    }
  }

  if (!home || b.trail.length) {
    // we are outside with a trail
    const threat = enemyHeadNear(b, 6);
    if (threat || b.trail.length >= b.maxOut) b.returning = true;

    if (b.returning) {
      const target = nearestOwnCell(b);
      if (target) return towards(b, target.x, target.y, pool);
      return pick(pool);                        // homeless — wander
    }
    // carve a loop: straight runs joined by same-sign turns
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

  // at home, safe: reset and occasionally set out on a new raid
  b.returning = false; b.turnCount = 0;
  b.homeX = b.cx; b.homeY = b.cy;
  if (b.planSteps <= 0) {
    b.turnSign = Math.random() < 0.5 ? 1 : -1;
    b.planSteps = randInt(4, 9);
    b.maxOut = randInt(16, 34);
  }
  // drift away from walls
  const margin = 6;
  if (b.cx < margin && pool.includes(DIRS[0])) return DIRS[0];
  if (b.cx >= GRID - margin && pool.includes(DIRS[1])) return DIRS[1];
  if (b.cy < margin && pool.includes(DIRS[2])) return DIRS[2];
  if (b.cy >= GRID - margin && pool.includes(DIRS[3])) return DIRS[3];
  if (Math.random() < 0.15) return pick(pool);
  if (pool.includes(b.dir)) return b.dir;
  return pick(pool);
}

/* ---------------- update loop ---------------- */
function loop(now) {
  if (!running) return;
  requestAnimationFrame(loop);
  let dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  // boost energy: drains while held, refills over time
  if (human.alive) {
    const draining = boostHeld && !boostLock && human.energy > 0;
    if (draining) {
      human.energy = Math.max(0, human.energy - BOOST_DRAIN * dt);
      if (human.energy === 0) boostLock = true;      // must recover before re-boosting
    } else {
      human.energy = Math.min(100, human.energy + BOOST_REGEN * dt);
      if (boostLock && human.energy > 20) boostLock = false;
    }
    boostActive = draining;
  } else {
    boostActive = false;
  }

  for (const p of players) {
    if (p.alive) stepPlayer(p, dt);
    else if (!p.isHuman && now > p.deadUntil && p.deadUntil > 0) { p.deadUntil = 0; spawn(p); }
  }

  // particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const pt = particles[i];
    pt.t += dt;
    if (pt.t >= pt.life) { particles.splice(i, 1); continue; }
    pt.x += pt.vx * dt; pt.y += pt.vy * dt;
    pt.vx *= 0.92; pt.vy *= 0.92;
  }
  for (let i = flashes.length - 1; i >= 0; i--) {
    flashes[i].t += dt;
    if (flashes[i].t > 0.45) flashes.splice(i, 1);
  }

  // camera follows the player (even briefly after death)
  const targetX = human.x * CELL + CELL / 2 - window.innerWidth / 2;
  const targetY = human.y * CELL + CELL / 2 - window.innerHeight / 2;
  camX += (targetX - camX) * Math.min(1, dt * 6);
  camY += (targetY - camY) * Math.min(1, dt * 6);

  hudTimer += dt;
  if (hudTimer > 0.2) { hudTimer = 0; updateHud(); }

  if (human.alive) {
    const a = areaPct(human);
    if (!human._maxArea || a > human._maxArea) human._maxArea = a;
  }

  render();
}

/* ---------------- rendering ---------------- */
function render() {
  const W = window.innerWidth, H = window.innerHeight;
  ctx.fillStyle = '#e8edf6';                     // out-of-bounds
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.translate(-camX, -camY);

  // playfield
  ctx.fillStyle = '#f5f8fd';
  ctx.fillRect(0, 0, WORLD, WORLD);

  const x0 = clamp(Math.floor(camX / CELL) - 1, 0, GRID);
  const y0 = clamp(Math.floor(camY / CELL) - 1, 0, GRID);
  const x1 = clamp(Math.ceil((camX + W) / CELL) + 1, 0, GRID);
  const y1 = clamp(Math.ceil((camY + H) / CELL) + 1, 0, GRID);

  // grid lines
  ctx.strokeStyle = 'rgba(37,99,235,0.09)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = x0; x <= x1; x++) { ctx.moveTo(x * CELL, y0 * CELL); ctx.lineTo(x * CELL, y1 * CELL); }
  for (let y = y0; y <= y1; y++) { ctx.moveTo(x0 * CELL, y * CELL); ctx.lineTo(x1 * CELL, y * CELL); }
  ctx.stroke();

  // territory fills
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = owner[y * GRID + x];
      if (o !== -1 && players[o]) {
        ctx.fillStyle = rgba(players[o].color, 0.42);
        ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      }
    }
  }

  // territory borders (edges where the owner changes)
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = owner[y * GRID + x];
      if (o === -1 || !players[o]) continue;
      ctx.strokeStyle = players[o].color;
      ctx.beginPath();
      if (x === 0 || owner[y * GRID + x - 1] !== o)          { ctx.moveTo(x * CELL, y * CELL); ctx.lineTo(x * CELL, (y + 1) * CELL); }
      if (x === GRID - 1 || owner[y * GRID + x + 1] !== o)   { ctx.moveTo((x + 1) * CELL, y * CELL); ctx.lineTo((x + 1) * CELL, (y + 1) * CELL); }
      if (y === 0 || owner[(y - 1) * GRID + x] !== o)        { ctx.moveTo(x * CELL, y * CELL); ctx.lineTo((x + 1) * CELL, y * CELL); }
      if (y === GRID - 1 || owner[(y + 1) * GRID + x] !== o) { ctx.moveTo(x * CELL, (y + 1) * CELL); ctx.lineTo((x + 1) * CELL, (y + 1) * CELL); }
      ctx.stroke();
    }
  }

  // capture flashes
  for (const f of flashes) {
    const a = 0.5 * (1 - f.t / 0.45);
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    for (const idx of f.cells) {
      const x = idx % GRID, y = (idx / GRID) | 0;
      if (x >= x0 && x < x1 && y >= y0 && y < y1) ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
    }
  }

  // trails
  for (const p of players) {
    if (!p.alive || !p.trail.length) continue;
    ctx.fillStyle = rgba(p.color, 0.62);
    for (const idx of p.trail) {
      const x = idx % GRID, y = (idx / GRID) | 0;
      if (x >= x0 - 1 && x < x1 + 1 && y >= y0 - 1 && y < y1 + 1)
        ctx.fillRect(x * CELL + 1.5, y * CELL + 1.5, CELL - 3, CELL - 3);
    }
    // connect trail end to moving head
    ctx.fillRect(
      Math.min(p.x, p.cx) * CELL + 1.5, Math.min(p.y, p.cy) * CELL + 1.5,
      (Math.abs(p.x - p.cx) + 1) * CELL - 3, (Math.abs(p.y - p.cy) + 1) * CELL - 3
    );
  }

  // world border
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 5;
  ctx.strokeRect(0, 0, WORLD, WORLD);

  // players
  for (const p of players) {
    if (!p.alive) continue;
    const px = p.x * CELL + CELL / 2, py = p.y * CELL + CELL / 2;
    const s = CELL * 0.86;
    ctx.save();
    ctx.translate(px, py);
    ctx.shadowColor = 'rgba(30,41,59,.35)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = p.color;
    roundRect(ctx, -s / 2, -s / 2, s, s, 8);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 3;
    ctx.strokeStyle = p.dark;
    roundRect(ctx, -s / 2, -s / 2, s, s, 8);
    ctx.stroke();
    ctx.restore();

    // spawn-protection shield
    const nowMs = performance.now();
    if (p.protectedUntil > nowMs) {
      const pulse = 0.5 + 0.4 * Math.sin(nowMs / 90);
      ctx.strokeStyle = `rgba(250,204,21,${pulse})`;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(px, py, CELL * 0.95, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${pulse * 0.8})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, CELL * 1.12, 0, Math.PI * 2);
      ctx.stroke();
    }

    // name tag for others
    if (!p.isHuman) {
      ctx.font = '700 13px "Baloo 2", sans-serif';
      const w = ctx.measureText(p.name).width + 14;
      ctx.fillStyle = 'rgba(255,255,255,.88)';
      roundRect(ctx, px - w / 2, py - CELL * 1.35, w, 20, 8);
      ctx.fill();
      ctx.fillStyle = p.dark;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.name, px, py - CELL * 1.35 + 10.5);
    }
  }

  // particles
  for (const pt of particles) {
    const a = 1 - pt.t / pt.life;
    ctx.fillStyle = pt.color;
    ctx.globalAlpha = a;
    ctx.fillRect(pt.x - pt.size / 2, pt.y - pt.size / 2, pt.size, pt.size);
  }
  ctx.globalAlpha = 1;

  ctx.restore();
  drawMinimap();
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/* ---------------- minimap ---------------- */
function drawMinimap() {
  if (mmDirty) {
    mmDirty = false;
    mmBufCtx.clearRect(0, 0, GRID, GRID);
    const img = mmBufCtx.createImageData(GRID, GRID);
    for (let i = 0; i < owner.length; i++) {
      const o = owner[i];
      if (o === -1 || !players[o]) continue;
      const n = parseInt(players[o].color.slice(1), 16);
      img.data[i * 4] = (n >> 16) & 255;
      img.data[i * 4 + 1] = (n >> 8) & 255;
      img.data[i * 4 + 2] = n & 255;
      img.data[i * 4 + 3] = 235;
    }
    mmBufCtx.putImageData(img, 0, 0);
  }
  const S = mmCanvas.width;
  mmCtx.clearRect(0, 0, S, S);
  mmCtx.fillStyle = '#f0f3f9';
  mmCtx.fillRect(0, 0, S, S);
  // faint grid
  mmCtx.strokeStyle = 'rgba(100,116,139,.15)';
  mmCtx.lineWidth = 1;
  mmCtx.beginPath();
  for (let i = 1; i < 6; i++) {
    mmCtx.moveTo(i * S / 6, 0); mmCtx.lineTo(i * S / 6, S);
    mmCtx.moveTo(0, i * S / 6); mmCtx.lineTo(S, i * S / 6);
  }
  mmCtx.stroke();
  mmCtx.imageSmoothingEnabled = false;
  mmCtx.drawImage(mmBuf, 0, 0, S, S);
  // other players' heads as dots
  const dotR = Math.max(3.5, S * 0.02);
  for (const p of players) {
    if (!p.alive || p.isHuman) continue;
    mmCtx.fillStyle = p.color;
    mmCtx.strokeStyle = '#fff';
    mmCtx.lineWidth = 1.5;
    mmCtx.beginPath();
    mmCtx.arc(p.x / GRID * S, p.y / GRID * S, dotR, 0, Math.PI * 2);
    mmCtx.fill(); mmCtx.stroke();
  }
  // the human, white-cored and on top
  if (human && human.alive) {
    const hx = human.x / GRID * S, hy = human.y / GRID * S;
    mmCtx.fillStyle = '#fff';
    mmCtx.strokeStyle = human.color;
    mmCtx.lineWidth = 2.5;
    mmCtx.beginPath();
    mmCtx.arc(hx, hy, dotR * 1.3, 0, Math.PI * 2);
    mmCtx.fill(); mmCtx.stroke();
  }
}

/* minimap size presets */
function applyMapSize() {
  const size = MAP_SIZES[clamp(store.data.mapSize, 0, MAP_SIZES.length - 1)];
  const box = $('minimap-box');
  box.style.width = size + 'px';
  box.style.height = size + 'px';
  mmCanvas.width = size * 2;      // 2x for crisp rendering
  mmCanvas.height = size * 2;
  mmDirty = true;
}
$('btn-map-plus').addEventListener('click', () => {
  store.data.mapSize = clamp(store.data.mapSize + 1, 0, MAP_SIZES.length - 1);
  store.save(); applyMapSize(); audio.click();
});
$('btn-map-minus').addEventListener('click', () => {
  store.data.mapSize = clamp(store.data.mapSize - 1, 0, MAP_SIZES.length - 1);
  store.save(); applyMapSize(); audio.click();
});

/* ---------------- HUD ---------------- */
function updateHud() {
  countCells();
  const sc = score(human), ar = areaPct(human);
  $('hpc-score').textContent = sc.toLocaleString();
  $('hpc-area').textContent = ar.toFixed(1) + '%';
  $('hpc-bar-fill').style.width = clamp(ar, 0, 100) + '%';
  $('hpc-energy').textContent = Math.round(human.energy) + '%';
  $('hpc-boost-fill').style.width = clamp(human.energy, 0, 100) + '%';

  const ranked = players.slice().sort((a, b) => score(b) - score(a));
  const rows = $('lb-rows');
  rows.innerHTML = '';
  ranked.slice(0, 5).forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'lb-row' + (p.isHuman ? ' me' : '');
    row.innerHTML =
      (i < 3 ? `<span class="accent" style="background:${p.color}"></span>` : '') +
      `<span class="lb-rank">${i + 1}</span>` +
      `<span class="lb-dot" style="background:${p.color};opacity:${p.alive ? 1 : 0.3}"></span>` +
      `<span class="lb-name">${escapeHtml(p.name)}</span>` +
      `<span class="lb-score">${score(p).toLocaleString()}</span>`;
    rows.appendChild(row);
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- game over ---------------- */
function endGame(finalScore, rank, maxArea) {
  running = false;

  const d = store.data;
  d.games++;
  d.kills += human.kills;
  if (finalScore > d.bestScore) d.bestScore = finalScore;
  if (!d.bestRank || rank < d.bestRank) d.bestRank = rank;
  if (maxArea > d.bestArea) d.bestArea = maxArea;
  const won = rank === 1 && finalScore >= 100;   // a real win, not a tie at spawn
  d.streak = won ? d.streak + 1 : 0;

  const xpEarned = Math.max(10, Math.round(finalScore / 12) + human.kills * 40 + (won ? 150 : 0));
  const before = levelFromXp(d.xp);
  d.xp += xpEarned;
  const after = levelFromXp(d.xp);
  store.save();

  $('go-name').textContent = human.name;
  $('go-avatar').style.background = human.color;
  $('go-streak').textContent = d.streak;
  $('go-score').textContent = finalScore.toLocaleString();
  $('go-rank').textContent = '#' + rank;
  $('go-area').textContent = maxArea.toFixed(0) + '%';
  $('go-level').textContent = 'Level ' + after.lvl +
    (after.lvl > before.lvl ? ' 🎉' : '');
  $('go-xp').textContent = `+${xpEarned} XP earned`;
  $('go-level-fill').style.width = '0%';
  $('gameover').classList.remove('hidden');
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      $('go-level-fill').style.width = (after.rest / after.need * 100) + '%'));

  human._lastResult = { score: finalScore, rank, area: maxArea };
}

$('btn-play-again').addEventListener('click', () => { audio.click(); startGame(); });
$('btn-back-menu').addEventListener('click', () => {
  audio.click();
  running = false;
  $('gameover').classList.add('hidden');
  $('game').classList.add('hidden');
  $('menu').classList.remove('hidden');
});

function resultText() {
  const r = human._lastResult || { score: 0, rank: 0, area: 0 };
  return `I scored ${r.score.toLocaleString()} points and claimed ${r.area.toFixed(0)}% of the arena (rank #${r.rank}) in ARENA.IO! Can you beat me?`;
}
$('btn-share').addEventListener('click', async () => {
  audio.click();
  if (navigator.share) {
    try { await navigator.share({ title: 'ARENA.IO', text: resultText() }); } catch (e) {}
  } else {
    copyResult();
  }
});
$('btn-copy').addEventListener('click', () => { audio.click(); copyResult(); });
function copyResult() {
  const txt = resultText();
  if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => toast('Result copied to clipboard!'));
  else toast(txt);
}

/* ---------------- in-game settings (game keeps running — no pause) ---------------- */
$('btn-game-settings').addEventListener('click', () => {
  audio.click();
  $('game-settings-panel').classList.toggle('hidden');
  $('btn-sound').textContent = 'Sound: ' + (store.data.sound ? 'On' : 'Off');
});
$('btn-resume').addEventListener('click', () => {
  audio.click();
  $('game-settings-panel').classList.add('hidden');
});
$('btn-sound').addEventListener('click', function () {
  store.data.sound = !store.data.sound; store.save();
  this.textContent = 'Sound: ' + (store.data.sound ? 'On' : 'Off');
  audio.click();
});
$('btn-quit').addEventListener('click', () => {
  audio.click();
  running = false;
  $('game-settings-panel').classList.add('hidden');
  $('game').classList.add('hidden');
  $('menu').classList.remove('hidden');
});

/* ---------------- input ---------------- */
const KEY_DIRS = {
  ArrowRight: DIRS[0], KeyD: DIRS[0],
  ArrowLeft: DIRS[1],  KeyA: DIRS[1],
  ArrowDown: DIRS[2],  KeyS: DIRS[2],
  ArrowUp: DIRS[3],    KeyW: DIRS[3]
};

window.addEventListener('keydown', e => {
  if (!running) {
    if (e.code === 'Enter' && !$('menu').classList.contains('hidden')
        && document.activeElement === $('name-input')) {
      startGame();
    }
    return;
  }
  const d = KEY_DIRS[e.code];
  if (d) {
    e.preventDefault();
    if (human.alive) {
      const last = human.queue.length ? human.queue[human.queue.length - 1] : human.dir;
      if (!isReverse(d, last) && d !== last && human.queue.length < 2) human.queue.push(d);
    }
  } else if (e.code === 'Space') {
    e.preventDefault();
    boostHeld = true;
  } else if (e.code === 'Escape') {
    $('btn-game-settings').click();
  }
});

window.addEventListener('keyup', e => {
  if (e.code === 'Space') boostHeld = false;
});

$('btn-play').addEventListener('click', startGame);

/* touch: swipe to steer; a second finger held down = boost */
let touchStart = null;
canvas.addEventListener('touchstart', e => {
  touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  boostHeld = e.touches.length >= 2;
}, { passive: true });
canvas.addEventListener('touchend', e => {
  boostHeld = e.touches.length >= 2;
}, { passive: true });
canvas.addEventListener('touchmove', e => {
  if (!touchStart || !running || !human.alive) return;
  const dx = e.touches[0].clientX - touchStart.x;
  const dy = e.touches[0].clientY - touchStart.y;
  if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return;
  let d;
  if (Math.abs(dx) > Math.abs(dy)) d = dx > 0 ? DIRS[0] : DIRS[1];
  else d = dy > 0 ? DIRS[2] : DIRS[3];
  const last = human.queue.length ? human.queue[human.queue.length - 1] : human.dir;
  if (!isReverse(d, last) && d !== last && human.queue.length < 2) human.queue.push(d);
  touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: true });

resize();
