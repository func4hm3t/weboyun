/* =====================================================================
   İHATA — a paper.io style territory conquest game
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

const POWERUP_TYPES = {
  speed:  { icon: '⚡', color: '#f59e0b', dur: 5000 },
  shield: { icon: '🛡️', color: '#3b82f6', dur: 7000 },
  bomb:   { icon: '💥', color: '#a855f7', dur: 0 },
  energy: { icon: '🔋', color: '#22c55e', dur: 0 }
};
const POWERUP_KEYS = Object.keys(POWERUP_TYPES);
const POWERUP_INTERVAL = 5;       // seconds between spawns
const POWERUP_MAX = 6;            // max on the field at once
const POWERUP_LIFE = 20000;       // ms before an unclaimed pickup despawns

// bot personalities: hunters chase kills, farmers grow quietly, expanders carve huge loops
const PERSONAS = {
  hunter:   { tag: '⚔️', maxOutMin: 20, maxOutMax: 40, threat: 4, killChance: 0.98, planMin: 4, planMax: 10 },
  farmer:   { tag: '🌾', maxOutMin: 10, maxOutMax: 18, threat: 9, killChance: 0.5,  planMin: 3, planMax: 6 },
  expander: { tag: '🗺️', maxOutMin: 28, maxOutMax: 50, threat: 6, killChance: 0.75, planMin: 6, planMax: 12 }
};
const PERSONA_KEYS = Object.keys(PERSONAS);

// level required to use each skin, in ALL_SKINS order (first row is free)
const SKIN_UNLOCK_LEVELS = [1, 1, 1, 1, 1, 2, 3, 5, 7, 10];

const COMBO_WINDOW = 4000;        // ms between kills to keep a streak alive
const COMBO_BONUS = 150;          // extra points per streak step
const COMBO_NAMES = ['DOUBLE KILL!', 'TRIPLE KILL!', 'RAMPAGE!', 'GODLIKE!'];

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
      name: '', room: '', roomPass: '', roomMax: 10, roomBots: true,
      skin: 0, sound: true, mapSize: 1,
      xp: 0, streak: 0, games: 0, bestScore: 0, bestRank: 0, kills: 0, bestArea: 0
    }, this.data);
    if (this.data.room === 'public') this.data.room = '';
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
  powerup() { this.beep(760, 0.18, 'triangle', 0.14, 240); },
  deny()    { this.beep(140, 0.15, 'square', 0.08); },
  combo(n)  { this.beep(500 + n * 120, 0.22, 'square', 0.15, 220); },
  death()   { this.beep(320, 0.5, 'sawtooth', 0.16, -260); },
  start()   { this.beep(520, 0.12, 'triangle', 0.1, 140); }
};

/* ---------------- background music (generative synth loop) ----------------
   132 bpm, i–VI–iv–VII minor progression. A bass pulse always plays;
   the arpeggio and hi-hat layers fade in as the player claims more area. */
const music = {
  playing: false, timer: null, step: 0, nextTime: 0, gain: null,
  start() {
    if (!store.data.sound || this.playing) return;
    audio.ensure();
    if (!audio.ctx) return;
    if (!this.gain) {
      this.gain = audio.ctx.createGain();
      this.gain.connect(audio.ctx.destination);
    }
    this.gain.gain.value = 0.05;
    this.playing = true;
    this.step = 0;
    this.nextTime = audio.ctx.currentTime + 0.05;
    this.timer = setInterval(() => this.schedule(), 100);
  },
  stop() {
    this.playing = false;
    clearInterval(this.timer);
  },
  note(freq, t, dur, type, vol) {
    const o = audio.ctx.createOscillator(), g = audio.ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.gain);
    o.start(t); o.stop(t + dur);
  },
  schedule() {
    if (!this.playing) return;
    const spb = 60 / 132 / 2;                    // eighth notes
    while (this.nextTime < audio.ctx.currentTime + 0.3) {
      this.playStep(this.step, this.nextTime);
      this.nextTime += spb;
      this.step = (this.step + 1) % 64;
    }
  },
  playStep(s, t) {
    const chords = [[0, 3, 7, 10], [-4, 0, 3, 8], [5, 8, 12, 15], [-2, 2, 5, 10]];
    const chord = chords[(s / 16) | 0];
    const semi = n => 110 * Math.pow(2, n / 12); // root A2
    const intensity = human && human.alive ? clamp(areaPct(human) / 30, 0, 1) : 0;
    if (s % 4 === 0) this.note(semi(chord[0]) / 2, t, 0.3, 'triangle', 0.55);
    if (s % 2 === 0) this.note(semi(chord[(s / 2) % 4] + 12), t, 0.13, 'square', 0.06 + 0.14 * intensity);
    if (intensity > 0.45 && s % 4 === 2) this.note(5500 + Math.random() * 1500, t, 0.03, 'square', 0.05);
  }
};

/* =====================================================================
   MENU
   ===================================================================== */
function buildSkinRows() {
  const lvl = levelFromXp(store.data.xp).lvl;
  if (lvl < (SKIN_UNLOCK_LEVELS[store.data.skin] || 1)) { store.data.skin = 0; store.save(); }
  const make = (row, colors, offset) => {
    row.innerHTML = '';
    colors.forEach((c, i) => {
      const idx = offset + i;
      const needed = SKIN_UNLOCK_LEVELS[idx] || 1;
      const locked = lvl < needed;
      const el = document.createElement('div');
      el.className = 'skin' + (store.data.skin === idx ? ' selected' : '') + (locked ? ' locked' : '');
      el.innerHTML = `<div class="skin-square" style="background:${c};box-shadow:inset 0 -5px 0 ${rgba(c,0)}, 0 4px 10px ${rgba(c,.35)}"></div>` +
        (locked ? `<div class="skin-lock">🔒<span>Lv ${needed}</span></div>` : `<div class="skin-check">✓</div>`);
      el.addEventListener('click', () => {
        if (locked) {
          audio.deny();
          toast(`Reach level ${needed} to unlock this skin!`);
          return;
        }
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

const params = new URLSearchParams(location.search);
$('name-input').value = store.data.name || '';
const urlRoom = (params.get('room') || '').slice(0, 24);
const urlPass = (params.get('pass') || '').slice(0, 48);
$('room-input').value = urlRoom || store.data.room || '';
$('room-pass-input').value = urlRoom ? urlPass : (store.data.roomPass || '');
$('room-max').value = String(Math.min(store.data.roomMax || 10, 10));
$('room-bots').checked = store.data.roomBots !== false;

/* private room panel */
let roomMode = 'create';           // 'create' | 'join'
function setPrivPanel(open) {
  $('priv-panel').classList.toggle('hidden', !open);
  $('btn-priv-toggle').classList.toggle('open', open);
}
function setRoomMode(mode) {
  roomMode = mode;
  const create = mode === 'create';
  $('tab-create').classList.toggle('active', create);
  $('tab-join').classList.toggle('active', !create);
  $('room-opts').classList.toggle('hidden', !create);
  $('btn-room-dice').classList.toggle('hidden', !create);
  $('room-grid').classList.toggle('nodice', !create);
  $('room-btns-create').classList.toggle('hidden', !create);
  $('room-btns-join').classList.toggle('hidden', create);
  $('room-hint').textContent = create
    ? 'You set the rules: up to 10 players, bots on or off. Share the room name and password with friends.'
    : 'Enter the exact room name (and its password if it has one), or pick a room from Browse Rooms.';
}
$('tab-create').addEventListener('click', () => { audio.click(); setRoomMode('create'); });
$('tab-join').addEventListener('click', () => { audio.click(); setRoomMode('join'); });
$('btn-priv-toggle').addEventListener('click', () => {
  audio.click();
  const opening = $('priv-panel').classList.contains('hidden');
  setPrivPanel(opening);
  if (opening && !$('room-input').value) $('room-input').focus();
});
if (urlRoom) {
  setPrivPanel(true);   // arrived via an invite link
  setRoomMode('join');
  toast(`🔗 Invite to room "${urlRoom}" — press JOIN ROOM`);
}

const ROOM_ADJ = ['turbo', 'neon', 'mega', 'hyper', 'royal', 'crazy', 'pixel', 'shadow', 'golden', 'cosmic'];
const ROOM_NOUN = ['duel', 'clash', 'league', 'battle', 'party', 'zone', 'derby', 'rumble', 'showdown', 'siege'];
$('btn-room-dice').addEventListener('click', () => {
  audio.click();
  $('room-input').value = `${pick(ROOM_ADJ)}-${pick(ROOM_NOUN)}-${randInt(10, 99)}`;
});

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
    if (!store.data.sound) music.stop();
    else if (running) music.start();
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
let powerups = [];
let powerupTimer = 0;
let shake = 0;                    // screen shake magnitude (px)
let timeScale = 1;                // slow motion on death

/* ---- multiplayer state ---- */
let online = false, ws = null, myId = -1;
let playersById = new Map();
let roomInfo = null;              // {id, l, lk, mx, b} for the joined room
const canOnline = typeof location !== 'undefined'
  && /^https?:$/.test(location.protocol)
  && typeof WebSocket !== 'undefined';

function configuredWsUrl() {
  const fromWindow = String(window.IHATA_WS_URL || '').trim();
  const fromQuery = new URLSearchParams(location.search).get('server');
  const raw = String(fromQuery || fromWindow || '').trim();
  if (!raw) return '';
  return raw.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://').replace(/\/+$/, '');
}

function allPlayers() { return online ? Array.from(playersById.values()) : players; }
function getP(id) { return online ? playersById.get(id) : players[id]; }
function hasTrail(p) { return online ? !!p.h : p.trail.length > 0; }
function sendMsg(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

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
    shieldUntil: 0, speedUntil: 0, persona: null, tag: '',
    x: 0, y: 0, cx: 0, cy: 0, tx: 0, ty: 0,
    dir: DIRS[0], queue: [],
    trail: [], cells: 0, kills: 0,
    comboCount: 0, comboLast: 0, bonus: 0,
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
  p.shieldUntil = 0; p.speedUntil = 0;
  p.comboCount = 0; p.comboLast = 0;
  p.returning = false; p.turnCount = 0; p.planSteps = 0;
  for (let y = p.cy - 1; y <= p.cy + 1; y++)
    for (let x = p.cx - 1; x <= p.cx + 1; x++)
      owner[y * GRID + x] = p.id;
  // head to the side with most space
  p.dir = p.cx < GRID / 2 ? DIRS[0] : DIRS[1];
  p.tx = p.cx + p.dir.x; p.ty = p.cy + p.dir.y;
  mmDirty = true;
}

function startGame() {                 // quick play: public arena
  launchGame('public', '', null);
}

function startRoomGame() {             // private room from the panel
  const room = $('room-input').value.trim().slice(0, 24);
  if (!room) {
    toast('Enter a room name first');
    $('room-input').focus();
    return;
  }
  const pass = $('room-pass-input').value.slice(0, 48);
  const opts = roomMode === 'create'
    ? { max: parseInt($('room-max').value, 10) || 10, bots: $('room-bots').checked }
    : null;
  launchGame(room, pass, opts, roomMode);
}

function launchGame(room, roomPass, opts, mode) {
  const name = ($('name-input').value.trim() || 'Player One').slice(0, 14);
  store.data.name = name;
  if (room !== 'public') {
    store.data.room = room;
    store.data.roomPass = roomPass;
  }
  if (opts) {
    store.data.roomMax = opts.max;
    store.data.roomBots = opts.bots;
  }
  store.save();
  if (canOnline) {
    connectOnline(name, room, roomPass, opts, mode);
  } else {
    if (room !== 'public') toast('Rooms need the online server — playing offline vs bots');
    startOffline(name);
  }
}

function enterGameScreen() {
  $('hpc-name').textContent = human.name;
  $('hpc-swatch').style.background = human.color;
  $('hpc-bar-fill').style.background = human.color;
  $('killfeed').innerHTML = '';
  particles = []; flashes = [];
  shake = 0; timeScale = 1;
  boostHeld = false; boostLock = false; boostActive = false;

  $('menu').classList.add('hidden');
  $('gameover').classList.add('hidden');
  $('game').classList.remove('hidden');
  $('game-settings-panel').classList.add('hidden');
  applyMapSize();
  resize();

  camX = human.x * CELL + CELL / 2 - window.innerWidth / 2;
  camY = human.y * CELL + CELL / 2 - window.innerHeight / 2;
  mmDirty = true;
  running = true;
  lastTime = performance.now();
  audio.ensure(); audio.start();
  music.start();
  toast('🛡️ Spawn shield active — you are protected for 2s!');
  updateHud();
  requestAnimationFrame(loop);
}

function startOffline(name) {
  online = false; ws = null;
  roomInfo = null;
  $('room-badge').classList.add('hidden');

  owner = new Int16Array(GRID * GRID).fill(-1);
  trailMap = new Int16Array(GRID * GRID).fill(-1);
  players = [];
  powerups = []; powerupTimer = 0;
  deathHandled = false;

  const humanColor = ALL_SKINS[store.data.skin] || SKINS[0];
  human = makePlayer(0, name, humanColor, true);
  players.push(human);

  const botColors = ALL_SKINS.filter(c => c !== humanColor);
  const names = BOT_NAMES.slice();
  for (let i = 0; i < BOT_COUNT; i++) {
    const nm = names.splice(Math.floor(Math.random() * names.length), 1)[0];
    const bot = makePlayer(i + 1, nm, botColors[i % botColors.length], false);
    bot.persona = PERSONAS[PERSONA_KEYS[i % PERSONA_KEYS.length]];
    bot.tag = bot.persona.tag;
    players.push(bot);
  }
  players.forEach(spawn);

  human.energy = 100;
  enterGameScreen();
}

/* ---------------- online client ---------------- */
function connectOnline(name, room, roomPass, opts, mode) {
  const color = ALL_SKINS[store.data.skin] || SKINS[0];
  const btn = mode === 'create' ? $('btn-room-create')
    : mode === 'join' ? $('btn-room-join')
    : $('btn-play');
  const btnLabel = btn.querySelector('span');
  const idleLabel = mode === 'create' ? 'CREATE ROOM' : mode === 'join' ? 'JOIN ROOM' : 'PLAY';
  btnLabel.textContent = 'CONNECTING...';
  const reset = () => { btnLabel.textContent = idleLabel; };

  let settled = false;
  let sock;
  const fallback = () => {           // server unreachable: offline vs bots
    if (settled) return;
    settled = true;
    reset();
    try { sock && sock.close(); } catch (e) {}
    toast('Server not found — playing offline vs bots');
    startOffline(name);
  };
  const rejected = (message) => {    // server said no: stay in the menu
    if (settled) return;
    settled = true;
    reset();
    try { sock && sock.close(); } catch (e) {}
    audio.deny();
    toast(message);
  };
  try {
    const url = configuredWsUrl() || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    sock = new WebSocket(url);
  } catch (e) { fallback(); return; }

  const timer = setTimeout(fallback, 2000);

  sock.onopen = () => sock.send(JSON.stringify({
    t: 'join', n: name, c: color, r: room, pw: roomPass,
    mx: opts ? opts.max : 0, b: opts ? (opts.bots ? 1 : 0) : 1,
    md: mode === 'create' ? 'c' : mode === 'join' ? 'j' : ''
  }));
  sock.onerror = () => {};
  sock.onclose = () => {
    if (!settled) { clearTimeout(timer); fallback(); return; }
    if (online && ws === sock) {
      online = false; ws = null;
      music.stop();
      if (running || !$('gameover').classList.contains('hidden')) {
        running = false;
        $('game').classList.add('hidden');
        $('gameover').classList.add('hidden');
        $('menu').classList.remove('hidden');
        toast('Connection lost');
      }
    }
  };
  sock.onmessage = ev => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.t === 'init') {
      settled = true;
      clearTimeout(timer);
      reset();
      ws = sock; online = true;
      initOnline(m);
    } else if (m.t === 'err') {
      clearTimeout(timer);
      rejected(
        m.code === 'bad_password' ? '🔒 Wrong password for this room'
        : m.code === 'room_full' ? 'Room is full — try another one'
        : m.code === 'room_exists' ? 'That room name is taken — pick another or use Join Room'
        : m.code === 'no_room' ? 'Room not found — check the name or create it'
        : 'Could not join room');
    } else if (online && ws === sock) {
      handleNet(m);
    }
  };
}

function addNetPlayer(d) {
  const p = {
    id: d.i, name: d.n, color: d.c, dark: shade(d.c, -0.28),
    isHuman: false, bot: !!d.b, tag: d.pt || '',
    alive: !!d.a, x: d.x, y: d.y, sx: d.x, sy: d.y,
    cx: d.cx, cy: d.cy, h: !!d.h,
    kills: d.k || 0, cells: d.cl || 0, sc: d.sc || 0,
    protectedUntil: d.pr > 0 ? performance.now() + d.pr : 0,
    shieldUntil: d.sh > 0 ? performance.now() + d.sh : 0,
    speedUntil: 0, bonus: 0,
    trail: [], energy: 100
  };
  playersById.set(p.id, p);
  return p;
}

function initOnline(m) {
  owner = Int16Array.from(m.o);
  trailMap = Int16Array.from(m.tr);
  playersById = new Map();
  for (const d of m.p) addNetPlayer(d);
  myId = m.id;
  human = playersById.get(myId);
  human.isHuman = true;
  human.energy = 100;
  powerups = (m.pu || []).map(u => ({ id: u.i, cx: u.x, cy: u.y, type: u.tp }));
  deathHandled = false;
  roomInfo = m.ri || { id: 'public', l: m.r || 'public', lk: 0, mx: 16, b: 1 };
  enterGameScreen();

  const badge = $('room-badge');
  if (roomInfo.id !== 'public') {
    $('room-badge-name').textContent = `${roomInfo.lk ? '🔒' : '🏠'} ${roomInfo.l}`;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  const humans = [...playersById.values()].filter(p => !p.bot).length;
  if (roomInfo.id !== 'public') {
    toast(`🏠 Room "${roomInfo.l}" — ${humans}/${roomInfo.mx} player${humans > 1 ? 's' : ''}. Tap 🔗 to invite friends!`);
  } else {
    toast(`🌐 Online arena — ${humans} player${humans > 1 ? 's' : ''} connected`);
  }
}

function handleNet(m) {
  if (m.t === 'st') {
    for (const s of m.p) {
      // [id, x, y, alive, protMs, cx, cy, hasTrail, kills, cells, score, shieldMs]
      const p = playersById.get(s[0]);
      if (!p) continue;
      const wasAlive = p.alive;
      p.sx = s[1]; p.sy = s[2];
      p.alive = !!s[3];
      p.protectedUntil = s[4] > 0 ? performance.now() + s[4] : 0;
      p.cx = s[5]; p.cy = s[6];
      p.h = !!s[7];
      p.kills = s[8]; p.cells = s[9]; p.sc = s[10];
      p.shieldUntil = s[11] > 0 ? performance.now() + s[11] : 0;
      if (!wasAlive && p.alive) { p.x = p.sx; p.y = p.sy; }   // respawn: snap
    }
    if (m.od) { for (let i = 0; i < m.od.length; i += 2) owner[m.od[i]] = m.od[i + 1]; if (m.od.length) mmDirty = true; }
    if (m.td) { for (let i = 0; i < m.td.length; i += 2) trailMap[m.td[i]] = m.td[i + 1]; }
    if (typeof m.e === 'number' && human) human.energy = m.e;
  } else if (m.t === 'pj') {
    const p = addNetPlayer(m.p);
    if (!p.bot && p.id !== myId) toast(`${p.name} joined the arena`);
  } else if (m.t === 'pl') {
    const p = playersById.get(m.i);
    if (p && !p.bot) toast(`${p.name} left`);
    playersById.delete(m.i);
  } else if (m.t === 'cap') {
    const p = playersById.get(m.i);
    if (p) {
      flashes.push({ cells: m.cs, t: 0, color: p.color });
      if (m.i === myId) audio.capture(m.cs.length);
      mmDirty = true;
    }
  } else if (m.t === 'kill') {
    const v = playersById.get(m.vi);
    if (v) burst(v.x, v.y, v.color, 26);
    const k = m.ki !== -1 ? playersById.get(m.ki) : null;
    addKillFeed(
      m.ki !== -1 && m.ki !== m.vi ? { name: m.kn, dark: k ? k.dark : '#334155' } : null,
      { name: m.vn, dark: v ? v.dark : '#334155' }
    );
    if (m.ki === myId) {
      audio.kill();
      shake = Math.max(shake, 8);
      if (m.cb >= 2) {
        showCombo(COMBO_NAMES[Math.min(m.cb - 2, COMBO_NAMES.length - 1)]);
        audio.combo(m.cb);
        toast(`Combo x${m.cb}! +${(m.cb - 1) * COMBO_BONUS} bonus`);
      } else {
        toast(`You eliminated ${m.vn}! +${KILL_BONUS}${m.g ? ` and claimed ${m.g} cells` : ''}`);
      }
    }
  } else if (m.t === 'sha') {
    const p = playersById.get(m.i);
    if (p) burst(p.x, p.y, '#60a5fa', 14);
    if (m.i === myId) toast('🛡️ Your shield absorbed the hit!');
  } else if (m.t === 'pua') {
    powerups.push({ id: m.u.i, cx: m.u.x, cy: m.u.y, type: m.u.tp });
  } else if (m.t === 'pur') {
    const k = powerups.findIndex(u => u.id === m.i);
    if (k >= 0) powerups.splice(k, 1);
    if (m.pi !== -1) {
      const p = playersById.get(m.pi);
      if (p) burst(p.cx, p.cy, POWERUP_TYPES[m.tp].color, 16);
      if (m.pi === myId) {
        audio.powerup();
        const labels = { speed: 'Speed boost!', shield: 'Shield up!', bomb: 'Area claimed!', energy: 'Energy refilled!' };
        toast(`${POWERUP_TYPES[m.tp].icon} ${labels[m.tp]}`);
      }
    }
  } else if (m.t === 'dead') {
    audio.death();
    shake = 16;
    if (human) burst(human.x, human.y, human.color, 26);
    setTimeout(() => endGame(m.s, m.r, m.a), 900);
  }
}

/* ---------------- core rules ---------------- */
function countCells() {
  players.forEach(p => p.cells = 0);
  for (let i = 0; i < owner.length; i++) {
    const o = owner[i];
    if (o !== -1 && players[o]) players[o].cells++;
  }
}

function score(p) { return online ? (p.sc || 0) : p.cells + p.kills * KILL_BONUS + p.bonus; }
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
  // pickup shield absorbs one lethal hit, then breaks
  if (killer !== null && victim.shieldUntil > performance.now()) {
    victim.shieldUntil = 0;
    burst(victim.x, victim.y, '#60a5fa', 14);
    if (victim.isHuman) toast('🛡️ Your shield absorbed the hit!');
    else if (killer && killer.isHuman && killer !== victim) toast(`${victim.name}'s shield absorbed it!`);
    return;
  }
  victim.alive = false;
  burst(victim.x, victim.y, victim.color, 26);
  addKillFeed(killer, victim);
  if (victim.isHuman) shake = 16;
  else if (killer && killer.isHuman) shake = 8;

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
    // kill streak: chained kills inside the combo window earn escalating bonuses
    const nowK = performance.now();
    killer.comboCount = nowK - killer.comboLast < COMBO_WINDOW ? killer.comboCount + 1 : 1;
    killer.comboLast = nowK;
    if (killer.comboCount >= 2) killer.bonus += (killer.comboCount - 1) * COMBO_BONUS;
    if (killer.isHuman) {
      audio.kill();
      if (killer.comboCount >= 2) {
        showCombo(COMBO_NAMES[Math.min(killer.comboCount - 2, COMBO_NAMES.length - 1)]);
        audio.combo(killer.comboCount);
        toast(`Combo x${killer.comboCount}! +${(killer.comboCount - 1) * COMBO_BONUS} bonus`);
      } else {
        toast(`You eliminated ${victim.name}! +${KILL_BONUS}${gained.length ? ` and claimed ${gained.length} cells` : ''}`);
      }
    }
  }
  if (victim.isHuman) {
    audio.death();
    timeScale = 0.3;                             // slow-motion send-off
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

/* ---------------- power-ups ---------------- */
function spawnPowerup() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const cx = randInt(2, GRID - 3), cy = randInt(2, GRID - 3);
    if (trailMap[cy * GRID + cx] !== -1) continue;
    if (powerups.some(u => u.cx === cx && u.cy === cy)) continue;
    powerups.push({ cx, cy, type: pick(POWERUP_KEYS), born: performance.now() });
    return;
  }
}

function applyPowerup(p, type) {
  const now = performance.now();
  if (type === 'speed') {
    p.speedUntil = now + POWERUP_TYPES.speed.dur;
  } else if (type === 'shield') {
    p.shieldUntil = now + POWERUP_TYPES.shield.dur;
  } else if (type === 'energy') {
    if (p.isHuman) { p.energy = 100; boostLock = false; }
    else p.speedUntil = now + 2500;              // bots convert it to a short sprint
  } else if (type === 'bomb') {
    // instantly claim a 5x5 patch (never eats trail cells — that would corrupt captures)
    const claimed = [];
    for (let y = Math.max(0, p.cy - 2); y <= Math.min(GRID - 1, p.cy + 2); y++)
      for (let x = Math.max(0, p.cx - 2); x <= Math.min(GRID - 1, p.cx + 2); x++) {
        const i = y * GRID + x;
        if (owner[i] !== p.id && trailMap[i] === -1) { owner[i] = p.id; claimed.push(i); }
      }
    if (claimed.length) { flashes.push({ cells: claimed, t: 0, color: p.color }); mmDirty = true; }
  }
  burst(p.cx, p.cy, POWERUP_TYPES[type].color, 16);
  if (p.isHuman) {
    audio.powerup();
    const labels = { speed: 'Speed boost!', shield: 'Shield up!', bomb: 'Area claimed!', energy: 'Energy refilled!' };
    toast(`${POWERUP_TYPES[type].icon} ${labels[type]}`);
  }
}

function onArrive(p) {
  const { cx, cy } = p;
  if (cx < 0 || cy < 0 || cx >= GRID || cy >= GRID) {
    p.cx = clamp(cx, 0, GRID - 1);
    p.cy = clamp(cy, 0, GRID - 1);
    p.x = p.cx;
    p.y = p.cy;
    if (cx < 0) p.dir = DIRS[0];
    else if (cx >= GRID) p.dir = DIRS[1];
    else if (cy < 0) p.dir = DIRS[2];
    else if (cy >= GRID) p.dir = DIRS[3];
    return;
  }
  const idx = cy * GRID + cx;

  for (let i = powerups.length - 1; i >= 0; i--) {
    if (powerups[i].cx === cx && powerups[i].cy === cy) {
      applyPowerup(p, powerups.splice(i, 1)[0].type);
    }
  }

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
  const fast = (p.isHuman && boostActive) || p.speedUntil > performance.now();
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
  const P = b.persona || PERSONAS.expander;
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
      if (t !== -1 && t !== b.id && Math.random() < P.killChance) return d;
    }
  }

  if (!home || b.trail.length) {
    // we are outside with a trail
    const threat = enemyHeadNear(b, P.threat);
    if (threat || b.trail.length >= b.maxOut) b.returning = true;

    if (b.returning) {
      const target = nearestOwnCell(b);
      if (target) return towards(b, target.x, target.y, pool);
      return pick(pool);                        // homeless — wander
    }
    // carve a loop: straight runs joined by same-sign turns
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

  // at home, safe: reset and occasionally set out on a new raid
  b.returning = false; b.turnCount = 0;
  b.homeX = b.cx; b.homeY = b.cy;
  if (b.planSteps <= 0) {
    b.turnSign = Math.random() < 0.5 ? 1 : -1;
    b.planSteps = randInt(P.planMin, P.planMax);
    b.maxOut = randInt(P.maxOutMin, P.maxOutMax);
  }
  // hunters stalk the nearest unshielded prey even from home turf
  if (P === PERSONAS.hunter) {
    let prey = null, pd = Infinity;
    for (const q of players) {
      if (q === b || !q.alive || q.protectedUntil > performance.now()) continue;
      const d = Math.abs(q.cx - b.cx) + Math.abs(q.cy - b.cy);
      if (d < pd) { pd = d; prey = q; }
    }
    if (prey && pd < 18 && Math.random() < 0.7) return towards(b, prey.cx, prey.cy, pool);
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
  const rdt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;
  const dt = rdt * timeScale;

  // screen shake decays in real time
  shake = Math.max(0, shake - shake * 6 * rdt);
  if (shake < 0.3) shake = 0;

  if (online) {
    // server drives the simulation: smooth towards its positions, snap on big jumps
    for (const p of playersById.values()) {
      const ddx = p.sx - p.x, ddy = p.sy - p.y;
      if (Math.abs(ddx) + Math.abs(ddy) > 4) { p.x = p.sx; p.y = p.sy; }
      else {
        const k = Math.min(1, dt * 14);
        p.x += ddx * k; p.y += ddy * k;
      }
    }
  } else {
    // power-up spawning / expiry
    powerupTimer += rdt;
    if (powerupTimer >= POWERUP_INTERVAL && powerups.length < POWERUP_MAX) {
      powerupTimer = 0;
      spawnPowerup();
    }
    for (let i = powerups.length - 1; i >= 0; i--)
      if (now - powerups[i].born > POWERUP_LIFE) powerups.splice(i, 1);

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

  if (!online && human.alive) {
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
  const shakeX = shake ? (Math.random() - 0.5) * shake : 0;
  const shakeY = shake ? (Math.random() - 0.5) * shake : 0;
  ctx.translate(-camX + shakeX, -camY + shakeY);

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
      const q = o !== -1 ? getP(o) : null;
      if (q) {
        ctx.fillStyle = rgba(q.color, 0.42);
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
      const q = o !== -1 ? getP(o) : null;
      if (!q) continue;
      ctx.strokeStyle = q.color;
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

  // trails (read from the trail map so it works online and offline)
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const t = trailMap[y * GRID + x];
      if (t === -1) continue;
      const q = getP(t);
      if (!q) continue;
      ctx.fillStyle = rgba(q.color, 0.62);
      ctx.fillRect(x * CELL + 1.5, y * CELL + 1.5, CELL - 3, CELL - 3);
    }
  }
  // connect each trail end to its moving head
  for (const p of allPlayers()) {
    if (!p.alive || !hasTrail(p)) continue;
    ctx.fillStyle = rgba(p.color, 0.62);
    ctx.fillRect(
      Math.min(p.x, p.cx) * CELL + 1.5, Math.min(p.y, p.cy) * CELL + 1.5,
      (Math.abs(p.x - p.cx) + 1) * CELL - 3, (Math.abs(p.y - p.cy) + 1) * CELL - 3
    );
  }

  // power-ups
  const nowT = performance.now();
  for (const u of powerups) {
    if (u.cx < x0 - 1 || u.cx > x1 || u.cy < y0 - 1 || u.cy > y1) continue;
    const ux = u.cx * CELL + CELL / 2, uy = u.cy * CELL + CELL / 2;
    const pulse = 1 + 0.12 * Math.sin(nowT / 160 + u.cx);
    const info = POWERUP_TYPES[u.type];
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    ctx.strokeStyle = info.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(ux, uy, CELL * 0.42 * pulse, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    ctx.font = `${Math.round(CELL * 0.5 * pulse)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(info.icon, ux, uy + 1);
  }

  // world border
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 5;
  ctx.strokeRect(0, 0, WORLD, WORLD);

  // players
  for (const p of allPlayers()) {
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

    // spawn-protection shield: glowing bubble + depleting timer arc + countdown badge
    const nowMs = performance.now();
    if (p.protectedUntil > nowMs) {
      const remain = (p.protectedUntil - nowMs) / PROTECT_MS;   // 1 → 0
      const pulse = 0.75 + 0.25 * Math.sin(nowMs / 80);
      const R = CELL * 1.15;
      ctx.fillStyle = `rgba(250,204,21,${0.22 * pulse})`;
      ctx.beginPath();
      ctx.arc(px, py, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(250,204,21,.3)';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(px, py, R, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = `rgba(245,158,11,${0.95 * pulse})`;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(px, py, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * remain);
      ctx.stroke();

      ctx.font = '800 13px "Baloo 2", sans-serif';
      const txt = '🛡️ ' + (Math.ceil((p.protectedUntil - nowMs) / 100) / 10).toFixed(1) + 's';
      const tw = ctx.measureText(txt).width + 14;
      ctx.fillStyle = 'rgba(255,255,255,.92)';
      roundRect(ctx, px - tw / 2, py + R + 5, tw, 20, 8);
      ctx.fill();
      ctx.fillStyle = '#b45309';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(txt, px, py + R + 15.5);
    }

    // pickup-shield ring (blue, distinct from the yellow spawn shield)
    if (p.shieldUntil > nowMs) {
      const pulse = 0.55 + 0.35 * Math.sin(nowMs / 110);
      ctx.strokeStyle = `rgba(59,130,246,${pulse})`;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(px, py, CELL * 1.02, 0, Math.PI * 2);
      ctx.stroke();
    }

    // name tag for others
    if (p !== human) {
      const label = (p.tag ? p.tag + ' ' : '') + p.name;
      ctx.font = '700 13px "Baloo 2", sans-serif';
      const w = ctx.measureText(label).width + 14;
      ctx.fillStyle = 'rgba(255,255,255,.88)';
      roundRect(ctx, px - w / 2, py - CELL * 1.35, w, 20, 8);
      ctx.fill();
      ctx.fillStyle = p.dark;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, px, py - CELL * 1.35 + 10.5);
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
      const q = o !== -1 ? getP(o) : null;
      if (!q) continue;
      const n = parseInt(q.color.slice(1), 16);
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
  for (const p of allPlayers()) {
    if (!p.alive || p === human) continue;
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
  if (!online) countCells();          // online: cell counts come from the server
  const sc = score(human), ar = areaPct(human);
  $('hpc-score').textContent = sc.toLocaleString();
  $('hpc-area').textContent = ar.toFixed(1) + '%';
  $('hpc-bar-fill').style.width = clamp(ar, 0, 100) + '%';
  $('hpc-energy').textContent = Math.round(human.energy) + '%';
  $('hpc-boost-fill').style.width = clamp(human.energy, 0, 100) + '%';

  const ranked = allPlayers().slice().sort((a, b) => score(b) - score(a));
  const rows = $('lb-rows');
  rows.innerHTML = '';
  ranked.slice(0, 5).forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'lb-row' + (p === human ? ' me' : '');
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

/* ---------------- combo banner ---------------- */
function showCombo(txt) {
  const b = $('combo-banner');
  b.textContent = txt;
  b.classList.remove('hidden', 'pop');
  void b.offsetWidth;                            // restart the CSS animation
  b.classList.add('pop');
  clearTimeout(b._tm);
  b._tm = setTimeout(() => b.classList.add('hidden'), 1400);
}

/* ---------------- kill feed ---------------- */
function addKillFeed(killer, victim) {
  const kf = $('killfeed');
  const row = document.createElement('div');
  row.className = 'kf-row';
  row.innerHTML = killer && killer !== victim
    ? `<span style="color:${killer.dark}">${escapeHtml(killer.name)}</span> ⚔️ <span style="color:${victim.dark}">${escapeHtml(victim.name)}</span>`
    : `<span style="color:${victim.dark}">${escapeHtml(victim.name)}</span> 💥`;
  kf.prepend(row);
  while (kf.children.length > 5) kf.lastChild.remove();
  setTimeout(() => {
    row.classList.add('out');
    setTimeout(() => row.remove(), 400);
  }, 3500);
}

/* ---------------- game over ---------------- */
function endGame(finalScore, rank, maxArea) {
  if (!online) {                 // online we keep spectating behind the overlay
    running = false;
    music.stop();
  }

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

  if (after.lvl > before.lvl) {
    const unlocked = SKIN_UNLOCK_LEVELS.filter(l => l > before.lvl && l <= after.lvl).length;
    if (unlocked) toast(`🎉 Level ${after.lvl} — ${unlocked} new skin${unlocked > 1 ? 's' : ''} unlocked!`);
  }
  buildSkinRows();                // refresh locks for the menu

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

function leaveGame() {
  running = false;
  music.stop();
  if (ws) { const s = ws; ws = null; online = false; try { s.close(); } catch (e) {} }
  online = false;
  roomInfo = null;
  $('room-badge').classList.add('hidden');
  $('game-settings-panel').classList.add('hidden');
  $('gameover').classList.add('hidden');
  $('game').classList.add('hidden');
  $('menu').classList.remove('hidden');
  buildSkinRows();
}

$('btn-play-again').addEventListener('click', () => {
  audio.click();
  if (online && ws) {
    sendMsg({ t: 'respawn' });
    $('gameover').classList.add('hidden');
    toast('🛡️ Respawned — protected for 2s!');
  } else {
    startGame();
  }
});
$('btn-back-menu').addEventListener('click', () => { audio.click(); leaveGame(); });

function resultText() {
  const r = human._lastResult || { score: 0, rank: 0, area: 0 };
  return `I scored ${r.score.toLocaleString()} points and claimed ${r.area.toFixed(0)}% of the arena (rank #${r.rank}) in İHATA! Can you beat me?`;
}
$('btn-share').addEventListener('click', async () => {
  audio.click();
  if (navigator.share) {
    try { await navigator.share({ title: 'İHATA', text: resultText() }); } catch (e) {}
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
  if (!store.data.sound) music.stop();
  else if (running) music.start();
  audio.click();
});
$('btn-quit').addEventListener('click', () => { audio.click(); leaveGame(); });

/* ---------------- input ---------------- */
const KEY_DIRS = {
  ArrowRight: DIRS[0], KeyD: DIRS[0],
  ArrowLeft: DIRS[1],  KeyA: DIRS[1],
  ArrowDown: DIRS[2],  KeyS: DIRS[2],
  ArrowUp: DIRS[3],    KeyW: DIRS[3]
};

function steer(d) {
  if (!human || !human.alive) return;
  if (online) {
    sendMsg({ t: 'dir', d: DIRS.indexOf(d) });
  } else {
    const last = human.queue.length ? human.queue[human.queue.length - 1] : human.dir;
    if (!isReverse(d, last) && d !== last && human.queue.length < 2) human.queue.push(d);
  }
}

function setBoost(on) {
  if (boostHeld === on) return;
  boostHeld = on;
  if (online) sendMsg({ t: 'boost', on: on ? 1 : 0 });
}

window.addEventListener('keydown', e => {
  if (!running) {
    if (e.code === 'Enter' && !$('menu').classList.contains('hidden')) {
      const el = document.activeElement;
      if (el === $('name-input')) startGame();
      else if (el === $('room-input') || el === $('room-pass-input')) startRoomGame();
    }
    return;
  }
  const d = KEY_DIRS[e.code];
  if (d) {
    e.preventDefault();
    steer(d);
  } else if (e.code === 'Space') {
    e.preventDefault();
    setBoost(true);
  } else if (e.code === 'Escape') {
    $('btn-game-settings').click();
  }
});

window.addEventListener('keyup', e => {
  if (e.code === 'Space') setBoost(false);
});

$('btn-play').addEventListener('click', startGame);
$('btn-room-create').addEventListener('click', startRoomGame);
$('btn-room-join').addEventListener('click', startRoomGame);
$('btn-room-browse').addEventListener('click', openRoomBrowser);

/* ---------------- invite links ---------------- */
function inviteLink() {
  const u = new URL(location.origin + location.pathname);
  if (roomInfo && roomInfo.id !== 'public') {
    u.searchParams.set('room', roomInfo.l);
    if (store.data.roomPass) u.searchParams.set('pass', store.data.roomPass);
  }
  const server = new URLSearchParams(location.search).get('server');
  if (server) u.searchParams.set('server', server);
  return u.toString();
}
$('btn-invite').addEventListener('click', () => {
  audio.click();
  const link = inviteLink();
  if (navigator.clipboard) {
    navigator.clipboard.writeText(link)
      .then(() => toast('🔗 Invite link copied — send it to your friends!'))
      .catch(() => toast(link));
  } else {
    toast(link);
  }
});

/* ---------------- room browser ---------------- */
function openRoomBrowser() {
  audio.click();
  openModal('Live Rooms',
    '<div class="room-list" id="room-list"><div class="room-empty">Connecting…</div></div>' +
    '<button class="room-refresh" id="room-refresh">↻ Refresh</button>');
  $('room-refresh').addEventListener('click', () => {
    audio.click();
    const el = $('room-list');
    if (el) el.innerHTML = '<div class="room-empty">Connecting…</div>';
    fetchRooms();
  });
  fetchRooms();
}

function fetchRooms() {
  const setEmpty = msg => {
    const el = $('room-list');
    if (el) el.innerHTML = `<div class="room-empty">${msg}</div>`;
  };
  if (!canOnline) { setEmpty('Rooms need the online server.'); return; }
  let sock;
  try {
    const url = configuredWsUrl() || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    sock = new WebSocket(url);
  } catch (e) { setEmpty('Server not reachable.'); return; }
  const timer = setTimeout(() => {
    try { sock.close(); } catch (e) {}
    setEmpty('Server not reachable.');
  }, 2500);
  sock.onopen = () => sock.send(JSON.stringify({ t: 'rooms' }));
  sock.onerror = () => {};
  sock.onmessage = ev => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.t !== 'rooms') return;
    clearTimeout(timer);
    try { sock.close(); } catch (e) {}
    renderRoomList(m.list || []);
  };
}

function renderRoomList(list) {
  const el = $('room-list');
  if (!el) return;                   // modal was closed meanwhile
  if (!list.length) {
    el.innerHTML = '<div class="room-empty">No live rooms — create the first one!</div>';
    return;
  }
  el.innerHTML = '';
  for (const r of list) {
    const row = document.createElement('button');
    row.className = 'room-row';
    row.innerHTML =
      `<span class="room-row-name">${r.id === 'public' ? '🌐' : r.lk ? '🔒' : '🏠'} ${escapeHtml(r.l)}</span>` +
      `<span class="room-row-meta">${r.b ? '🤖 ' : ''}👥 ${r.h}/${r.mx}</span>`;
    row.addEventListener('click', () => {
      audio.click();
      $('modal-backdrop').classList.add('hidden');
      if (r.id === 'public') { startGame(); return; }
      setPrivPanel(true);
      setRoomMode('join');
      $('room-input').value = r.l;
      $('room-pass-input').value = '';
      if (r.lk) {
        $('room-pass-input').focus();
        toast('🔒 This room is locked — enter its password');
      } else {
        startRoomGame();
      }
    });
    el.appendChild(row);
  }
}

/* touch: swipe to steer; a second finger held down = boost */
let touchStart = null;
canvas.addEventListener('touchstart', e => {
  touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  setBoost(e.touches.length >= 2);
}, { passive: true });
canvas.addEventListener('touchend', e => {
  setBoost(e.touches.length >= 2);
}, { passive: true });
canvas.addEventListener('touchmove', e => {
  if (!touchStart || !running || !human.alive) return;
  const dx = e.touches[0].clientX - touchStart.x;
  const dy = e.touches[0].clientY - touchStart.y;
  if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return;
  let d;
  if (Math.abs(dx) > Math.abs(dy)) d = dx > 0 ? DIRS[0] : DIRS[1];
  else d = dy > 0 ? DIRS[2] : DIRS[3];
  steer(d);
  touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: true });

resize();
