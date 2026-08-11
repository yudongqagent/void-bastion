// VOID BASTION — simulation.
//
// A vertically scrolling auto-shmup. The ship flies forward forever near the
// bottom of the screen while the world streams down past it; the swarm enters
// from the top and mostly kills itself against your guns trying to ram you.
//
// The player never steers and never aims. Guns fire themselves, the autopilot
// dodges, hull and shields regenerate. The whole point is that it is enjoyable
// to WATCH — so the interesting code here is the steering behaviour, not input
// handling, of which there is none.
//
// Threat model note for anyone touching the balance: contact damage is still
// the primary way you lose hull, exactly as in the old static-tower build, so
// every formula in balance.js carries over unchanged. What the autopilot adds
// is a variable damage-avoidance factor, which is why tools/headless.mjs
// measures survivability rather than assuming it.
//
// Every entity type is pooled. At wave 400 there can be 150 enemies, several
// hundred projectiles and a couple of thousand particles alive at once, and
// allocating those per frame would hand the GC a stutter every few seconds.

import {
  enemyHP, enemyCount, enemySpeed, enemyDamage, coinValue, waveClearBonus,
  spawnWindow, isBossWave, bossStats, spawnTable, ABILITIES, deriveStats,
  BOSS_INTERVAL, TUNING, WEAPONS, ELITE, eliteChance, eliteWeapon, SYSTEM,
  GROUND_TYPES, hullFor, difficulty, interestPrincipal,
} from './balance.js';
import { sectorForWave, sectorNumber, isSectorStart } from './sectors.js';
import {
  levelOf, phaseOf, isBossStep, firstStepOfLevel, bossForLevel, sectorForLevel,
  bossName, levelName, levelUpgrade, PHASES_PER_LEVEL,
} from './levels.js';
import { Terrain, groundFor } from './terrain.js';
import { craftParts, craftBodies } from './craft.js';

const TAU = Math.PI * 2;

// How far an enemy travels from entry to the ship in the reference layout that
// tools/simulate.mjs balances against. Real screens differ, so enemy speeds are
// rescaled to keep time-to-contact — the thing that actually decides whether a
// wave hurts you — the same everywhere.
const REFERENCE_APPROACH = 430;

// --- impact feel ------------------------------------------------------------
// Hitstop: a brief global freeze on a significant kill. It is what turns a
// state change ("that enemy is gone") into an impact ("I hit that"). Rendering
// continues through it, so the player sees a held frame rather than a gap.
const HITSTOP_MAX = 0.055;     // longest single freeze
const FREEZE_BUDGET = 0.05;    // seconds of freeze allowed per real second
// Below this significance a kill gets no freeze at all. Measured in a real
// browser, freezing on every kill put 15% of frames on hold at wave 35 — which
// is not punctuation, it is a stutter. Only kills that read as an event stop
// the clock; chaff dies to sparks and sound alone.
const HITSTOP_MIN_WEIGHT = 0.30;
const SLOWMO_DUR = 1.1;        // boss-death ramp
const SLOWMO_MIN = 0.30;       // time scale at the bottom of the ramp
// Above this speed multiplier the boss ramp is skipped entirely: at 4x it would
// cost ~3 seconds of wall clock every level, which is a toll the idle player
// never asked to pay.
const SLOWMO_MAX_SPEED = 2;

// Seconds a single wave may run before the survivors start enraging.
const ENRAGE_AFTER = 100;

// Where the ship holds station, as a fraction up from the bottom of the field.
const SHIP_BAND = 0.20;

// More craft on screen, each individually weaker. Wave TOTALS are held constant
// — count is multiplied and per-enemy hull, payout and ram damage are divided by
// the same factor — so this is a pure density/readability change that leaves
// balance.js's tuning, and therefore the whole prestige curve, untouched.
const SWARM_DENSITY = 2.1;

// Archetypes that hold station and shoot rather than closing to ram. An elite
// Drone that gained a gun still charges you — it just shoots on the way in.
const ARTILLERY = new Set(['sentinel', 'gunship', 'radial', 'lancer', 'dread']);

// Half-width of the laser column, before mastery widens it. The laser is a
// gun too, so it fires up the same straight line the cannon does.
const LASER_HALF_WIDTH = 9;

// Palette. Values above 1.0 are intentional: the renderer's HDR target turns
// that overshoot into bloom, so "hot" is literally a bigger number.
const COLORS = {
  drone:    [1.45, 0.24, 0.44],
  darter:   [1.50, 0.85, 0.20],
  brute:    [0.72, 0.34, 1.55],
  splitter: [0.22, 1.45, 0.62],
  shielder: [0.30, 0.62, 1.55],
  sentinel: [1.55, 0.52, 0.20],
  wraith:   [0.92, 0.72, 1.55],
  boss:     [1.60, 0.18, 0.30],
  ship:     [0.30, 1.05, 1.35],
  bullet:   [0.55, 1.30, 1.60],
  shield:   [0.35, 0.85, 1.50],
  coin:     [1.50, 1.15, 0.35],
  repair:   [0.30, 1.45, 0.70],
  debris:   [0.42, 0.40, 0.46],
  laser:    [0.45, 1.35, 1.75],
  missile:  [1.60, 0.80, 0.25],
  flak:     [1.55, 1.10, 0.30],
  arc:      [0.75, 0.70, 1.90],
  wing:     [0.35, 1.45, 0.95],
};

function fastPool(factory, initial) {
  const items = [];
  for (let i = 0; i < initial; i++) items.push(factory());
  return {
    items,
    cursor: 0,
    // Monotonic cursor makes acquisition O(1) amortised rather than an O(n)
    // scan, which matters once a pool holds thousands of particles.
    obtain() {
      const n = this.items.length;
      for (let i = 0; i < n; i++) {
        const idx = (this.cursor + i) % n;
        if (!this.items[idx].active) {
          this.cursor = (idx + 1) % n;
          return this.items[idx];
        }
      }
      const fresh = factory();
      this.items.push(fresh);
      this.cursor = 0;
      return fresh;
    },
  };
}

const newEnemy = () => ({
  active: false, x: 0, y: 0, vx: 0, vy: 0, hp: 0, maxHp: 0, speed: 0, radius: 10,
  sides: 3, dmg: 0, coin: 0, color: COLORS.drone, type: 'drone', angle: 0, spin: 0,
  shield: 0, maxShield: 0, hitFlash: 0, splits: 0, boss: false, ranged: false,
  fireT: 0, phase: false, phaseT: 0, distScale: 1, stun: 0,
  behavior: 'dive', t: 0, homeX: 0, amp: 0, freq: 0, holdY: 0, face: 0,
  ground: false, hull: null, accent: null, smokeT: 0,
  blast: 0, aura: 0, warded: 0, pack: 1, lastX: null,
  kx: 0, ky: 0, hitFlashMax: 0.12, hitPower: 0,
  weapon: null, wcd: 0, elite: false, burst: 0, burstT: 0, spin2: 0, bossDef: null,
});

const newBullet = () => ({
  active: false, x: 0, y: 0, vx: 0, vy: 0, dmg: 0, pierce: 1, life: 0,
  crit: false, radius: 3, hits: null, fromEnemy: false,
  homing: 0, drag: 0, minSpeed: 0, missile: false, system: null, split: 0,
});

const newParticle = () => ({
  active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 3,
  r: 1, g: 1, b: 1, drag: 0.94, kind: 0, rot: 0,
});

const newPickup = () => ({
  active: false, x: 0, y: 0, vx: 0, vy: 0, kind: 'coin', value: 0,
  life: 0, spin: 0, angle: 0, drawn: false,
});

const newWreck = () => ({
  active: false, x: 0, y: 0, vx: 0, vy: 0, angle: 0, spin: 0,
  alt: 1, life: 0, maxLife: 1, shape: 'slab', hw: 0, hh: 0, r0: 0, sides: 4,
  rot: 0, r: 1, g: 1, b: 1, burn: 0, smoke: 0,
});

const newDebris = () => ({
  active: false, x: 0, y: 0, vy: 0, r: 0, angle: 0, spin: 0, sides: 6,
  hp: 0, maxHp: 0, flash: 0,
});

export class Game {
  constructor(state, synth, renderer) {
    this.state = state;
    this.synth = synth;
    this.renderer = renderer;

    this.enemies = fastPool(newEnemy, 320);
    this.bullets = fastPool(newBullet, 500);
    this.particles = fastPool(newParticle, 1800);
    this.pickups = fastPool(newPickup, 320);
    this.debris = fastPool(newDebris, 40);
    this.wrecks = fastPool(newWreck, 200);

    this.floaters = [];
    this.events = [];

    // Seeded with a usable field: resize() can legitimately never fire (a tab
    // that is never laid out), and a zero-sized world puts the ship at NaN.
    this.w = 800; this.h = 600;
    this.insetTop = 0; this.insetRight = 0; this.insetBottom = 0;

    this.ship = { x: 400, y: 480, vx: 0, vy: 0, radius: 15, bank: 0, thrust: 0 };
    // Player override. `blend` is 1 while a finger is down and eases back to 0
    // after release, so control hands back to the autopilot smoothly instead of
    // the ship snapping out from under you mid-drag.
    this.manual = { x: 0, y: 0, active: false, blend: 0 };

    this.spawnQueue = [];
    this.spawnTimer = 0;
    this.spawnInterval = 1;
    this.waveActive = false;
    this.interWave = 1.2;
    this.waveTime = 0;
    this.enrage = 0;
    this.fireTimer = 0;
    this.wingAngle = 0;

    this.terrain = new Terrain();
    this.scroll = 0;
    this.scrollDelta = 0;
    this.fxSeed = 0x9e3779b9;
    this.scrollSpeed = 150;
    this.layers = [];
    this.nebulae = [];

    this.flashAmount = 0;
    this.flashColor = [0, 0, 0];
    this.timeScale = 1;
    this.paused = false;
    this.freeze = 0;               // hitstop remaining, in REAL seconds
    this.freezeBudget = FREEZE_BUDGET;
    this.slowmo = 0;
    this.reducedMotion = false;
    this._knocks = 0;

    this.buffs = {};
    this.singularity = null;
    this.lance = null;
    this.storm = null;
    this.stormTimer = 5;
    this.beams = [];
    this.arcs = [];
    this.shells = [];
    this.sysT = { missile: 1.2, flak: 2.0, arc: 0.9 };
    this.laserTick = 0;
    this.laserChain = [];
    this.warnT = 0;

    this.sector = sectorForWave(1, BOSS_INTERVAL);
    this._statsDirty = true;
    this._stats = null;

    this.applyLayout();
    this.buildBackdrop();
    this.terrain.reset(this.y0);
    this.recomputeStats();
  }

  emit(type, data) { this.events.push({ type, data }); }

  /** Player is steering. Coordinates are in CSS pixels within the canvas. */
  setManualTarget(x, y, lift = 0) {
    const m = this.manual;
    m.active = true;
    m.x = Math.min(Math.max(x, this.x0 + 16), this.x1 - 16);
    // Touch lifts the target above the finger so your thumb is not parked on
    // top of the one thing you are trying to watch.
    m.y = Math.min(Math.max(y - lift, this.y0 + 30), this.y1 - 18);
  }

  releaseManual() { this.manual.active = false; }

  get stats() {
    if (this._statsDirty) this.recomputeStats();
    return this._stats;
  }

  recomputeStats() {
    const { run, meta } = this.state;
    this._stats = deriveStats(run.upgrades, meta.lab, meta.prestiges);
    this._statsDirty = false;
  }

  markStatsDirty() { this._statsDirty = true; }

  // --- layout ---------------------------------------------------------------

  resize(w, h) {
    this.w = w; this.h = h;
    this.applyLayout();
    this.buildBackdrop();
    this.terrain.reset(this.y0);
  }

  /**
   * Tell the world how much of the viewport the UI is covering, so the flight
   * lane sits in what the player can actually SEE. Without this the permanent
   * upgrade panel would cover the ship — the one thing you most want to watch.
   */
  setInsets(top, right, bottom) {
    this.insetTop = top;
    this.insetRight = right;
    this.insetBottom = bottom;
    this.applyLayout();
  }

  applyLayout() {
    this.x0 = 0;
    this.x1 = Math.max(200, this.w - (this.insetRight || 0));
    this.y0 = this.insetTop || 0;
    this.y1 = Math.max(this.y0 + 200, this.h - (this.insetBottom || 0));
    this.fieldW = this.x1 - this.x0;
    this.fieldH = this.y1 - this.y0;
    this.cx = (this.x0 + this.x1) / 2;
    this.cy = (this.y0 + this.y1) / 2;
    this.shipHomeY = this.y1 - this.fieldH * SHIP_BAND;
    // Distance an entering enemy covers before it reaches the ship's band.
    this.approach = Math.max(160, this.shipHomeY - this.y0 + 60);
    if (!this.ship.placed) {
      this.ship.x = this.cx;
      this.ship.y = this.shipHomeY;
      this.ship.placed = true;
    }
    this.ship.x = Math.min(Math.max(this.ship.x, this.x0 + 30), this.x1 - 30);
    this.ship.y = Math.min(Math.max(this.ship.y, this.y0 + 40), this.y1 - 30);
  }

  // --- backdrop -------------------------------------------------------------

  buildBackdrop() {
    // Three parallax star layers. Depth drives both speed and brightness, which
    // is what sells "flying forward" with nothing but dots.
    this.layers = [];
    const density = (this.fieldW * this.fieldH) / 16000;
    for (const [depth, size, alpha] of [[0.35, 1.0, 0.34], [0.68, 1.5, 0.55], [1.15, 2.3, 0.85]]) {
      const stars = [];
      const n = Math.max(12, Math.round(density * depth));
      for (let i = 0; i < n; i++) {
        stars.push({
          x: this.x0 + Math.random() * this.fieldW,
          y: this.y0 + Math.random() * this.fieldH,
          r: size * (0.5 + Math.random() * 0.9),
          a: alpha * (0.4 + Math.random() * 0.6),
        });
      }
      this.layers.push({ depth, stars });
    }

    this.nebulae.length = 0;
    for (let i = 0; i < 2; i++) {
      this.nebulae.push({
        x: this.x0 + Math.random() * this.fieldW,
        y: this.y0 + Math.random() * this.fieldH,
        r: Math.min(this.fieldW, this.fieldH) * (0.32 + Math.random() * 0.3),
        a: 0.05 + Math.random() * 0.04,
        depth: 0.14 + Math.random() * 0.12,
      });
    }
  }

  updateBackdrop(dt) {
    const sec = this.sector;
    const base = this.scrollSpeed * (sec.scrollMult || 1);
    this.scroll += base * dt;
    // Published so falling wreckage drifts with the terrain it will land on.
    this.scrollDelta = base * dt;

    for (const layer of this.layers) {
      const v = base * layer.depth;
      for (const s of layer.stars) {
        s.y += v * dt;
        if (s.y > this.y1 + 4) {
          s.y = this.y0 - 4;
          s.x = this.x0 + Math.random() * this.fieldW;
        }
      }
    }
    for (const n of this.nebulae) {
      n.y += base * n.depth * dt;
      if (n.y - n.r > this.y1) {
        n.y = this.y0 - n.r;
        n.x = this.x0 + Math.random() * this.fieldW;
      }
    }

    this.terrain.update(dt, base * dt, this.x0, this.x1, this.y0, this.y1);
  }

  // --- zones ----------------------------------------------------------------

  enterSector(wave) {
    const next = sectorForLevel(levelOf(wave));
    const changed = next.id !== this.sector.id;
    this.sector = next;
    this.storm = null;
    this.stormTimer = 3 + Math.random() * 4;
    if (changed || wave <= 1) {
      this.emit('sector', { sector: next, index: levelOf(wave) });
      this.flash(next.haze.map((c) => c * 0.22), 0.55);
    }
  }

  spawnDebris() {
    const d = this.debris.obtain();
    d.active = true;
    d.r = 16 + Math.random() * 34;
    // Shootable. A rock you can break is an opportunity; one you can only be
    // hit by is a tax on idling — and the Asteroid Belt was ending runs at
    // wave 15 before this, which is exactly the hard-counter we ruled out.
    d.maxHp = enemyHP(this.state.run.wave) * 1.6;
    d.hp = d.maxHp;
    d.flash = 0;
    d.x = this.x0 + d.r + Math.random() * (this.fieldW - d.r * 2);
    d.y = this.y0 - d.r - 20;
    d.vy = (0.55 + Math.random() * 0.4);   // multiplier on scroll speed
    d.angle = Math.random() * TAU;
    d.spin = (Math.random() - 0.5) * 0.8;
    d.sides = 5 + ((Math.random() * 3) | 0);
  }

  /** Shatter a rock, scattering ore worth collecting. */
  breakDebris(d) {
    d.active = false;
    this.spawnExplosion(d.x, d.y, d.r, COLORS.debris, d.r > 38);
    this.synth.kill(d.r > 38);
    const ore = coinValue(this.state.run.wave) * 0.9 * (this.sector.coinMult || 1);
    for (let i = 0; i < 2; i++) {
      const p = this.pickups.obtain();
      p.active = true;
      p.kind = 'coin';
      p.value = ore / 2;
      p.x = d.x + (Math.random() - 0.5) * d.r;
      p.y = d.y + (Math.random() - 0.5) * d.r;
      p.vx = (Math.random() - 0.5) * 110;
      p.vy = -30 - Math.random() * 60;
      p.life = 9;
      p.angle = Math.random() * TAU;
      p.spin = (Math.random() - 0.5) * 5;
    }
  }

  // --- wave flow -------------------------------------------------------------

  startWave() {
    const wave = this.state.run.wave;
    const level = levelOf(wave);
    // Self-healing rather than only on a boundary: a run resumed from a save
    // starts mid-level, and keying purely off the boundary left it flying
    // through the Asteroid Belt with Outer Reach's palette and no debris.
    if (this.sector.id !== sectorForLevel(level).id || firstStepOfLevel(wave)) {
      this.enterSector(wave);
    }
    if (firstStepOfLevel(wave)) {
      this.emit('levelStart', {
        level, name: levelName(level), boss: bossName(level),
        tell: bossForLevel(level).tell, refit: levelUpgrade(level).label,
      });
    }
    const sec = this.sector;

    const table = spawnTable(wave);
    const total = table.reduce((a, t) => a + t.weight, 0);
    const count = Math.round(enemyCount(wave) * SWARM_DENSITY);
    const baseHP = enemyHP(wave) / SWARM_DENSITY;
    const baseDmg = enemyDamage(wave) / SWARM_DENSITY;
    const baseSpd = enemySpeed(wave);
    const baseCoin = coinValue(wave) / SWARM_DENSITY;

    const refit = levelUpgrade(levelOf(wave));
    const diff = difficulty(this.state.meta.difficulty);
    const eliteRate = eliteChance(wave);
    this.spawnQueue.length = 0;
    for (let i = 0; i < count; i++) {
      let r = Math.random() * total, pick = table[0];
      for (const t of table) { r -= t.weight; if (r <= 0) { pick = t; break; } }
      const a = pick.arch;
      const elite = Math.random() < eliteRate;
      const copies = a.pack || 1;
      const E = elite ? ELITE : null;
      const def = {
        type: pick.key,
        elite,
        hp: baseHP * a.hp * (sec.hpMult || 1) * (E ? E.hp : 1) * refit.hp * diff.hp,
        speed: baseSpd * a.speed * (sec.speedMult || 1) * (E ? E.speed : 1),
        dmg: baseDmg * a.dmg * (E ? E.dmg : 1) * refit.dmg * diff.dmg,
        coin: baseCoin * a.coin * (sec.coinMult || 1) * (E ? E.coin : 1),
        radius: a.radius * (E ? E.radius : 1), sides: a.sides,
        shield: a.shield ? baseHP * a.shield * 0.5 * (E ? E.hp : 1) : 0,
        phase: !!a.phase,
        ground: !!a.ground,
        // An elite always brings a gun, even if its archetype rams for a living.
        weapon: elite ? eliteWeapon(wave, a.weapon) : a.weapon,
        splits: pick.key === 'splitter' ? 2 : 0,
        blast: a.blast || 0,
        aura: a.aura || 0,
        standoff: a.standoff || 0,
      };
      // Chaff spawns as a cloud. One mite is noise; a flight of them is a wave.
      for (let c = 0; c < copies; c++) this.spawnQueue.push(c === 0 ? def : { ...def });
    }
    if (isBossWave(wave)) {
      const b = bossStats(wave);
      const def = bossForLevel(levelOf(wave));
      this.spawnQueue.push({
        type: 'boss', hp: b.hp * (sec.hpMult || 1) * def.hp * refit.hp * diff.hp,
        speed: b.speed * (sec.speedMult || 1),
        dmg: b.damage * refit.dmg * diff.dmg, coin: b.coins * (sec.coinMult || 1),
        radius: def.radius, sides: 8, shield: 0, boss: true, splits: 0,
        bossDef: def,
      });
      this.synth.boss();
      this.emit('boss', { wave, name: bossName(levelOf(wave)), tell: def.tell });
    }

    // Enemies arrive in formations rather than one at a time — a wall of six
    // sweeping down together reads far better than a trickle.
    this.formationSize = Math.min(12, 3 + Math.floor(Math.sqrt(wave) / 1.3));
    this.spawnInterval = (spawnWindow(wave) / Math.max(1, this.spawnQueue.length)) * this.formationSize;
    this.spawnTimer = 0;
    this.waveActive = true;
    this.waveTime = 0;
    this.enrage = 0;
    this.synth.waveStart(wave);
    this.emit('waveStart', { wave });
  }

  completeWave() {
    const { run } = this.state;
    const bonus = waveClearBonus(run.wave) * this.stats.coinMult * (this.sector.coinMult || 1);
    run.coins += bonus;
    this.addFloater(this.ship.x, this.ship.y - 60, '+' + Math.floor(bonus), COLORS.coin, 1.3);

    // Interest on whatever is still banked. Paid per phase so the choice
    // between spending and saving comes up constantly rather than once a level.
    const rate = this.stats.interest;
    if (rate > 0) {
      const gained = interestPrincipal(run.wave, run.coins) * rate;
      if (gained >= 1) {
        run.coins += gained;
        this.addFloater(this.ship.x, this.ship.y - 84,
          '+' + fmtShort(gained) + ' INTEREST', [0.45, 1.45, 0.75], 1.15);
        this.emit('interest', { gained });
      }
    }
    this.waveActive = false;
    this.interWave = 1.0;

    if (run.wave > this.state.meta.bestWave) this.state.meta.bestWave = run.wave;
    this.emit('waveClear', { wave: run.wave, bonus });

    if (run.wave % 25 === 0) {
      this.synth.milestone();
      this.flash([0.25, 0.5, 0.7], 0.55);
      this.emit('milestone', { wave: run.wave });
    }

    run.wave++;
    this.state.markDirty();
  }

  /** Release one formation of up to `formationSize` enemies in a pattern. */
  spawnFormation() {
    const n = Math.min(this.formationSize, this.spawnQueue.length);
    if (n <= 0) return;
    const pattern = ['line', 'vee', 'arc', 'column'][(Math.random() * 4) | 0];
    const margin = 46;
    const laneW = this.fieldW - margin * 2;
    const anchor = this.x0 + margin + Math.random() * laneW;

    for (let i = 0; i < n; i++) {
      const def = this.spawnQueue.shift();
      const t = n === 1 ? 0.5 : i / (n - 1);
      let x = anchor, yOff = 0;
      if (pattern === 'line') {
        x = this.x0 + margin + laneW * (0.5 + (t - 0.5) * 0.85);
      } else if (pattern === 'vee') {
        x = this.cx + (t - 0.5) * laneW * 0.7;
        yOff = -Math.abs(t - 0.5) * 120;
      } else if (pattern === 'arc') {
        x = this.cx + Math.sin((t - 0.5) * Math.PI) * laneW * 0.42;
        yOff = -Math.cos((t - 0.5) * Math.PI) * 70;
      } else {
        x = anchor;
        yOff = -i * 62;
      }
      this.spawnOne(def, x, yOff);
    }
  }

  spawnOne(def, x, yOff) {
    const e = this.enemies.obtain();
    e.active = true;
    e.x = Math.min(Math.max(x, this.x0 + 24), this.x1 - 24);
    e.y = this.y0 - 26 + (yOff || 0);
    e.hp = e.maxHp = def.hp;
    e.speed = def.speed;
    e.dmg = def.dmg;
    e.coin = def.coin;
    e.radius = def.radius;
    e.sides = def.sides;
    e.shield = e.maxShield = def.shield || 0;
    e.type = def.type;
    e.boss = !!def.boss;
    e.ground = !!def.ground;
    e.smokeT = 0;
    const hp = hullFor(def.type);
    e.hull = hp.hull;
    e.accent = hp.accent;
    e.elite = !!def.elite;
    e.blast = def.blast || 0;
    e.aura = def.aura || 0;
    e.warded = 0;
    e.kx = 0; e.ky = 0; e.hitPower = 0; e.hitFlashMax = 0.12;
    e.bossDef = def.bossDef || null;
    e.weapon = def.weapon || null;
    e.wcd = 0.6 + Math.random() * 1.4;
    e.burst = 0; e.burstT = 0; e.spin2 = Math.random() * TAU;
    e.phase = !!def.phase;
    e.splits = def.splits || 0;
    e.color = COLORS[def.type] || COLORS.drone;
    e.angle = 0;
    e.spin = 0;
    e.hitFlash = 0;
    e.fireT = 0.8 + Math.random();
    e.phaseT = Math.random() * TAU;
    e.stun = 0;
    e.t = 0;
    e.homeX = e.x;
    e.amp = 40 + Math.random() * 70;
    e.freq = 0.7 + Math.random() * 0.8;
    e.distScale = this.approach / REFERENCE_APPROACH;

    // Behaviour by archetype. "Most enemies attack by bumping" — dive and
    // swarm both end in a ram, which is why contact damage still drives the
    // balance model.
    if (def.ground) {
      // Emplacements are placed ON the map — snapped to a deck or headland if
      // one is passing, otherwise they ride open water.
      e.behavior = 'ground';
      const anchors = this.terrain.anchorPoints(this.y0 - 200, this.y0 + 60);
      if (anchors.length) {
        const a2 = anchors[(Math.random() * anchors.length) | 0];
        e.x = Math.min(Math.max(a2.x, this.x0 + 26), this.x1 - 26);
        e.y = a2.y;
      }
    } else if (def.boss) {
      e.behavior = 'boss';
      e.holdY = this.y0 + this.fieldH * 0.22;
    } else if (def.weapon && (ARTILLERY.has(def.type) || def.standoff)) {
      // Artillery holds station and shoots; it is not trying to reach you.
      e.behavior = 'hover';
      e.holdY = def.standoff
        ? this.y0 + this.fieldH * (def.standoff + Math.random() * 0.08)
        : this.y0 + this.fieldH * (0.16 + Math.random() * 0.42);
    } else if (def.type === 'darter' || def.type === 'wraith') {
      e.behavior = 'swarm';
    } else if (def.type === 'splitter' || def.type === 'shielder') {
      e.behavior = 'weave';
    } else {
      e.behavior = 'dive';
    }

    if (def.boss) this.flash([0.35, 0.05, 0.1], 0.5);
    return e;
  }

  // --- the autopilot ----------------------------------------------------------

  /**
   * Steering. This is the heart of "fun to watch": the ship has to look like a
   * competent pilot, not a magnet or a brick.
   *
   * Four weighted urges, summed and clamped:
   *   1. get away from anything about to hit us, weighted by how soon
   *   2. slide out of the path of incoming fire
   *   3. drift toward loose pickups
   *   4. hold station in the lower band and inside the lane
   *
   * Deliberately imperfect. A pilot that never takes a hit removes all tension
   * and makes hull, shields and armour upgrades pointless, so the threat radius
   * is short and the acceleration finite — it dodges what it can and wears what
   * it cannot.
   */
  steer(dt) {
    const s = this.stats;
    const ship = this.ship;
    let ax = 0, ay = 0;

    const evade = s.evasion || 1;
    const look = 150 * evade;

    // 1 & 2 — threats
    for (const e of this.enemies.items) {
      if (!e.active) continue;
      const dx = ship.x - e.x, dy = ship.y - e.y;
      const d = Math.hypot(dx, dy);
      if (d > look + e.radius) continue;
      const urgency = 1 - d / (look + e.radius);
      // Sideways is cheaper than vertical: the lane is wider than it is tall.
      ax += (dx / (d || 1)) * urgency * urgency * 2600;
      ay += (dy / (d || 1)) * urgency * urgency * 900;
    }
    for (const b of this.bullets.items) {
      if (!b.active || !b.fromEnemy) continue;
      const dx = ship.x - b.x, dy = ship.y - b.y;
      const d = Math.hypot(dx, dy);
      if (d > look * 0.8) continue;
      const urgency = 1 - d / (look * 0.8);
      // Break perpendicular to the bullet's travel — stepping aside beats
      // outrunning it.
      const bl = Math.hypot(b.vx, b.vy) || 1;
      const px = -b.vy / bl, py = b.vx / bl;
      const side = (px * dx + py * dy) >= 0 ? 1 : -1;
      ax += px * side * urgency * 2400;
      ay += py * side * urgency * 600;
    }
    // Beam columns: slide out of the lane rather than trying to outrun it.
    for (const bm of this.beams) {
      const dx = ship.x - bm.x;
      const reach = bm.w * 0.5 + 70;
      if (Math.abs(dx) > reach || ship.y < bm.y) continue;
      const urgency = 1 - Math.abs(dx) / reach;
      ax += (dx >= 0 ? 1 : -1) * urgency * 4200;
    }

    for (const d of this.debris.items) {
      if (!d.active) continue;
      const dx = ship.x - d.x, dy = ship.y - d.y;
      const dist = Math.hypot(dx, dy);
      const reach = d.r + look * 0.7;
      if (dist > reach) continue;
      const urgency = 1 - dist / reach;
      ax += (dx / (dist || 1)) * urgency * urgency * 3000;
      ay += (dy / (dist || 1)) * urgency * urgency * 1100;
    }

    // 3 — loose pickups worth a detour
    let bestP = null, bestD = 1e9;
    for (const p of this.pickups.items) {
      if (!p.active) continue;
      const dx = p.x - ship.x, dy = p.y - ship.y;
      const d = Math.hypot(dx, dy);
      if (d < bestD) { bestD = d; bestP = p; }
    }
    if (bestP && bestD < 260) {
      ax += ((bestP.x - ship.x) / (bestD || 1)) * 620;
      ay += ((bestP.y - ship.y) / (bestD || 1)) * 380;
    }

    // 4 — line up the shot. With fixed guns this is how damage happens at all,
    // so it pulls considerably harder than it did when the barrels could swing.
    // It still loses to an imminent threat: the ship breaks off to dodge and
    // slides back onto the target afterwards, which is what makes the autopilot
    // look like it is flying rather than drifting.
    if (this.target) {
      // Lead it. Weaving craft drift sideways, and steering at where one was
      // guarantees arriving a beat late for its whole approach.
      const t = this.target;
      const lead = (t.lastX != null ? (t.x - t.lastX) / Math.max(dt, 1e-4) : 0) * 0.22;
      const tdx = t.x + Math.max(-90, Math.min(90, lead)) - ship.x;
      ax += Math.max(-1, Math.min(1, tdx / 55)) * 2400;
    }

    // 5 — station keeping
    ay += (this.shipHomeY - ship.y) * 5.2;

    // --- player override -------------------------------------------------
    const m = this.manual;
    m.blend = m.active
      ? Math.min(1, m.blend + dt * 9)
      : Math.max(0, m.blend - dt * 2.2);
    if (m.blend > 0) {
      const mx = m.x - ship.x, my = m.y - ship.y;
      const md = Math.hypot(mx, my) || 1;
      // Arrival damping: full thrust when far, easing to nothing on contact, so
      // the ship settles under the finger instead of buzzing around it.
      const approach = Math.min(1, md / 55);
      const mAx = (mx / md) * approach * 7200;
      const mAy = (my / md) * approach * 7200;
      ax = ax * (1 - m.blend) + mAx * m.blend;
      ay = ay * (1 - m.blend) + mAy * m.blend;
    }

    // Bounds always apply, override or not — the lane is the lane.
    const edge = 44;
    if (ship.x < this.x0 + edge) ax += (this.x0 + edge - ship.x) * 22;
    if (ship.x > this.x1 - edge) ax -= (ship.x - (this.x1 - edge)) * 22;
    if (ship.y < this.y0 + 60) ay += (this.y0 + 60 - ship.y) * 22;
    if (ship.y > this.y1 - 34) ay -= (ship.y - (this.y1 - 34)) * 22;

    // Under manual control the pilot gets a little extra urgency, so dragging
    // feels responsive rather than like nudging a barge.
    const maxSpeed = 300 * evade * (1 + m.blend * 0.5);
    ship.vx += ax * dt;
    ship.vy += ay * dt;
    const drag = Math.pow(0.0016, dt);
    ship.vx *= drag;
    ship.vy *= drag;
    const sp = Math.hypot(ship.vx, ship.vy);
    if (sp > maxSpeed) { ship.vx = ship.vx / sp * maxSpeed; ship.vy = ship.vy / sp * maxSpeed; }

    ship.x += ship.vx * dt;
    ship.y += ship.vy * dt;
    ship.x = Math.min(Math.max(ship.x, this.x0 + 20), this.x1 - 20);
    ship.y = Math.min(Math.max(ship.y, this.y0 + 34), this.y1 - 22);
    // Bank into the turn; purely cosmetic but it is most of what makes the
    // autopilot read as a pilot.
    ship.bank += ((ship.vx / maxSpeed) * 0.5 - ship.bank) * Math.min(1, dt * 8);
    ship.thrust = 0.6 + Math.min(0.4, Math.abs(ship.vy) / 300);
  }

  // --- combat -----------------------------------------------------------------

  /**
   * Best thing to shoot: nearest enemy ahead of the ship, biased toward ones
   * roughly in front rather than far out to the side.
   *
   * The old static tower could rotate and engage anything in range. A ship
   * firing straight up cannot, and losing that was worth roughly six-sevenths
   * of the game's effective DPS — an unaided run died on wave 8 instead of the
   * high forties. Guns lead the target within a forward cone, and the autopilot
   * gently lines up on it, which restores the damage AND makes the pilot look
   * like it is aiming rather than spraying.
   */
  /**
   * The craft worth lining up under.
   *
   * With fixed guns this is no longer "what am I shooting" but "where should I
   * be", so lateral offset dominates the score: something slightly further away
   * but nearly dead ahead is a better answer than something close but off to
   * the side that the guns cannot reach anyway.
   */
  acquireTarget() {
    const ship = this.ship;
    const reach = this.stats.range * 1.8;
    const score = (e) => {
      const dx = Math.abs(e.x - ship.x), dy = ship.y - e.y;
      if (dy > reach) return Infinity;
      return dy * 0.35 + dx * 1.6;
    };
    const eligible = (e) =>
      e.active && e.y <= ship.y + 24 && !(e.phase && Math.sin(e.phaseT) > 0.55);

    let best = null, bestScore = Infinity;
    for (const e of this.enemies.items) {
      if (!eligible(e)) continue;
      const sc = score(e);
      if (sc < bestScore) { bestScore = sc; best = e; }
    }

    // Hysteresis: stay on the current target unless something is clearly
    // better. Without it the ship swaps target the instant two craft trade
    // places and spends the whole wave sliding between firing lines instead of
    // holding one — with fixed guns that is the difference between shooting and
    // merely aiming.
    const cur = this.target;
    if (cur && eligible(cur)) {
      const curScore = score(cur);
      if (curScore < bestScore * 1.45) return cur;
    }
    return best;
  }

  fire(dt) {
    const s = this.stats;
    const rate = s.fireRate * (this.buffs.overdrive > 0 ? 2.5 : 1);
    this.fireTimer -= dt;
    if (this.fireTimer > 0) return;
    this.fireTimer += 1 / Math.max(0.1, rate);

    const ship = this.ship;
    const aim = this.aimAngle();
    // Extra barrels are spaced ACROSS the nose, not fanned outward. A fan is a
    // cone by another name — it widens with distance and covers ground the
    // player never had to earn. Parallel streams give a fixed, honest footprint
    // you have to put over the target yourself.
    const spacing = 11;
    for (let i = 0; i < s.shots; i++) {
      const lateral = s.shots > 1 ? (i - (s.shots - 1) / 2) * spacing : 0;
      const ang = aim;
      const crit = Math.random() < s.critChance;
      const b = this.bullets.obtain();
      b.active = true;
      b.x = ship.x + lateral;
      b.y = ship.y - 18;
      const speed = 760;
      b.vx = Math.cos(ang) * speed;
      b.vy = Math.sin(ang) * speed;
      b.dmg = s.damage * (crit ? s.critMult : 1);
      b.crit = crit;
      b.pierce = s.pierce;
      b.life = 2.2;
      b.radius = crit ? 5 : 3.2;
      b.fromEnemy = false;
      b.system = null;
      b.hits = b.hits || new Set();
      b.hits.clear();
    }
    this.spawnMuzzle();
    this.synth.shot(1 + (this.buffs.overdrive > 0 ? 0.25 : 0));
  }

  /** Spawn one hostile projectile. */
  enemyShot(e, ang, w, speedMul = 1) {
    const b = this.bullets.obtain();
    b.active = true;
    b.x = e.x + Math.cos(ang) * e.radius * 0.8;
    b.y = e.y + Math.sin(ang) * e.radius * 0.8;
    const sp = w.speed * speedMul;
    b.vx = Math.cos(ang) * sp;
    b.vy = Math.sin(ang) * sp;
    b.dmg = e.dmg * w.dmg * TUNING.WEAPON_SCALE;
    b.pierce = 1;
    b.life = w.life || 6;
    b.radius = e.elite ? 5.5 : 4.5;
    b.crit = false;
    b.fromEnemy = true;
    b.homing = w.homing || 0;
    b.drag = w.drag || 0;
    b.minSpeed = w.drag ? sp * 0.22 : 0;
    b.hits = b.hits || new Set();
    b.hits.clear();
    return b;
  }

  /**
   * Run one enemy's armament.
   *
   * This is where difficulty actually lives. Contact damage is close to free
   * against an autopilot that dodges, so the swarm's real threat is ordnance —
   * aimed shots, decelerating homing volleys, radial sprays and beam columns —
   * which arrives faster than any pilot can side-step all of it.
   */
  fireWeapon(e, dt) {
    const w = WEAPONS[e.weapon];
    if (!w) return;
    const ship = this.ship;

    // Multi-shot volleys walk out over `gap` rather than appearing as one wall.
    if (e.burst > 0) {
      e.burstT -= dt;
      if (e.burstT <= 0) {
        e.burst--;
        e.burstT = w.gap || 0.1;
        const ang = Math.atan2(ship.y - e.y, ship.x - e.x);
        this.enemyShot(e, ang, w);
        this.synth.hit();
      }
      return;
    }

    e.wcd -= dt;
    if (e.wcd > 0) return;
    e.wcd = w.cd * (0.8 + Math.random() * 0.4);

    switch (e.weapon) {
      case 'beam': {
        // Telegraphed: a thin sight-line first, so the column is dodgeable if
        // you are paying attention and punishing if you are not.
        this.beams.push({ x: e.x, y: e.y, t: 0, dmg: e.dmg * w.dmg * TUNING.WEAPON_SCALE, owner: e, w: w.width });
        e.wcd = w.cd;
        break;
      }
      case 'radial': {
        e.spin2 += 0.4;
        for (let i = 0; i < w.count; i++) {
          this.enemyShot(e, e.spin2 + (i / w.count) * TAU, w);
        }
        this.synth.shot(0.6);
        break;
      }
      case 'spread': {
        const base = Math.atan2(ship.y - e.y, ship.x - e.x);
        for (let i = 0; i < w.count; i++) {
          this.enemyShot(e, base + (i - (w.count - 1) / 2) * w.spread, w);
        }
        this.synth.shot(0.5);
        break;
      }
      case 'homing': {
        const base = Math.atan2(ship.y - e.y, ship.x - e.x);
        for (let i = 0; i < w.count; i++) {
          this.enemyShot(e, base + (i - (w.count - 1) / 2) * w.spread, w);
        }
        this.synth.ability();
        break;
      }
      case 'burst': {
        e.burst = w.count;
        e.burstT = 0;
        break;
      }
      default: {
        this.enemyShot(e, Math.atan2(ship.y - e.y, ship.x - e.x), w);
        this.synth.hit();
        break;
      }
    }
  }

  /** Lancer beam columns: telegraph, fire, fade. */
  updateBeams(dt) {
    const w = WEAPONS.beam;
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const bm = this.beams[i];
      bm.t += dt;
      if (bm.owner && bm.owner.active) { bm.x = bm.owner.x; bm.y = bm.owner.y; }
      if (bm.t > w.telegraph && bm.t < w.telegraph + w.duration) {
        if (Math.abs(this.ship.x - bm.x) < bm.w * 0.5 + this.ship.radius &&
            this.ship.y > bm.y) {
          this.damageShip(bm.dmg * dt * 2.2, null);
        }
      }
      if (bm.t > w.telegraph + w.duration) this.beams.splice(i, 1);
    }
  }

  /**
   * @param {?number[]} dir Unit direction the hit travelled in, for knockback.
   *   Beams and area weapons pass nothing and produce no shove, which is
   *   correct — a laser should not push a hull around.
   *
   * Every response here scales with the FRACTION of the target's hull removed,
   * not the raw number. That is the only channel through which a damage upgrade
   * is perceivable: without it, Plasma Yield going 3.26K to 3.34K changes a
   * figure on a card and nothing whatsoever on screen.
   */
  damageEnemy(e, amount, crit, showNumber = true, dir = null) {
    if (e.warded) amount *= 0.42;
    if (e.shield > 0) {
      const absorbed = Math.min(e.shield, amount);
      e.shield -= absorbed;
      amount -= absorbed;
      if (absorbed > 0) this.synth.shieldHit();
    }
    e.hp -= amount;

    const frac = Math.max(0, Math.min(1, amount / (e.maxHp || 1)));
    e.hitFlash = Math.max(e.hitFlash, 0.08 + 0.14 * frac);
    e.hitFlashMax = e.hitFlash;
    e.hitPower = Math.max(e.hitPower || 0, frac);

    if (dir && this._knocks < 6) {
      // Bolted-down things shudder; they do not slide.
      const solid = e.boss || e.ground ? 0.15 : 1;
      const shove = Math.min(9, 62 * frac) * solid;
      if (shove > 0.4) {
        // A DRAWING offset, deliberately not a change to e.x/e.y. Moving the
        // real position shoves enemies up-lane, which stretches waves past the
        // enrage timer and cost ~15% of run depth in the A/B. The player cannot
        // tell the difference; the simulation very much can.
        e.kx += dir[0] * shove;
        e.ky += dir[1] * shove;
        this._knocks++;
      }
    }

    if (showNumber && amount >= 1 && (frac > 0.06 || Math.random() < 0.06)) {
      this.addFloater(e.x, e.y - e.radius, fmtShort(amount),
        crit ? [1.6, 1.2, 0.4] : [1, 1, 1], crit ? 1.1 + frac : 0.8 + frac * 0.5);
    }
    if (e.hp <= 0) this.killEnemy(e);
  }

  killEnemy(e, silent) {
    const { run, meta } = this.state;
    e.active = false;
    run.kills++;
    meta.totalKills++;

    this.spawnExplosion(e.x, e.y, e.radius, e.color, e.boss || e.blast > 0);
    this.spawnWreckage(e);
    this.synth.kill(e.boss || e.blast > 0);

    if (e.boss) {
      // A freeze on a boss is a hiccup; a ramp is a victory lap. Skipped when
      // the player is running the clock fast, where it would only cost them.
      if (this.timeScale <= SLOWMO_MAX_SPEED && !this.reducedMotion) {
        this.slowmo = SLOWMO_DUR;
      }
    } else {
      const weight = this.killWeight(e);
      if (weight >= HITSTOP_MIN_WEIGHT || e.elite) {
        this.addHitstop((0.012 + 0.05 * weight) * (e.elite ? 1.4 : 1));
      }
    }

    // A bomber is a trap as much as a target: shoot it early or eat the blast.
    if (e.blast > 0) {
      this.spawnRing(e.x, e.y, e.blast, [1.6, 0.5, 0.15], 0.42);
      this.addHitstop(0.05);
      const d = Math.hypot(this.ship.x - e.x, this.ship.y - e.y);
      if (d < e.blast + this.ship.radius) {
        const falloff = 1 - d / (e.blast + this.ship.radius);
        this.damageShip(e.dmg * TUNING.CONTACT_SCALE * 0.9 * falloff, null);
      }
    }

    if (!silent) this.dropLoot(e);

    if (this.stats.lifesteal > 0) {
      run.hull = Math.min(this.stats.maxHull, run.hull + this.stats.lifesteal);
    }

    if (e.boss) {
      this.flash([0.5, 0.15, 0.2], 0.8);
      this.emit('bossKill', { wave: run.wave });
    } else if (e.splits > 0) {
      for (let i = 0; i < e.splits; i++) {
        const c = this.enemies.obtain();
        Object.assign(c, {
          active: true, x: e.x + (Math.random() - 0.5) * 26, y: e.y,
          hp: e.maxHp * 0.32, maxHp: e.maxHp * 0.32, speed: e.speed * 1.4,
          dmg: e.dmg * 0.5, coin: e.coin * 0.3, radius: e.radius * 0.62,
          sides: 4, shield: 0, maxShield: 0, type: 'splitter', color: COLORS.splitter,
          boss: false, ranged: false, phase: false, splits: 0, behavior: 'swarm',
          angle: 0, spin: 0, hitFlash: 0, fireT: 0, phaseT: 0, stun: 0, t: 0,
          homeX: e.x, amp: 30, freq: 1.2, distScale: e.distScale,
        });
      }
    }
    this.state.markDirty();
  }

  /** Kills scatter physical loot the ship has to fly over to collect. */
  dropLoot(e) {
    const n = e.boss ? 14 : 1 + (Math.random() < 0.25 ? 1 : 0);
    const per = e.coin / n;
    for (let i = 0; i < n; i++) {
      const p = this.pickups.obtain();
      p.active = true;
      p.kind = 'coin';
      p.value = per;
      p.x = e.x + (Math.random() - 0.5) * (e.boss ? 90 : 18);
      p.y = e.y + (Math.random() - 0.5) * (e.boss ? 90 : 18);
      p.vx = (Math.random() - 0.5) * 90;
      p.vy = -40 - Math.random() * 70;
      p.life = 9;
      p.angle = Math.random() * TAU;
      p.spin = (Math.random() - 0.5) * 5;
    }
    // Occasional field repair — the pickup that makes a bad patch survivable.
    if (!e.boss && Math.random() < 0.012) this.dropRepair(e.x, e.y);
    else if (e.boss) this.dropRepair(e.x, e.y);
  }

  dropRepair(x, y) {
    const p = this.pickups.obtain();
    p.active = true;
    p.kind = 'repair';
    p.value = 0.16;                 // fraction of max hull
    p.x = x; p.y = y;
    p.vx = (Math.random() - 0.5) * 50;
    p.vy = -30;
    p.life = 11;
    p.angle = 0;
    p.spin = 1.4;
  }

  damageShip(amount, source) {
    const { run } = this.state;
    if (this.buffs.aegis > 0) { this.synth.shieldHit(); return; }
    if ((run.iframe || 0) > 0 || (run.spawnGuard || 0) > 0) return;
    const s = this.stats;
    let dmg = amount * (1 - s.armor);

    // Cap the bite of any single impact, then grant brief grace. Together these
    // guarantee a minimum number of hits — and therefore seconds — between full
    // hull and death, instead of an exponential ram deleting you in one frame.
    const cap = s.maxHull * TUNING.MAX_HIT_FRACTION;
    if (dmg > cap) {
      dmg = cap;
      run.iframe = TUNING.IFRAME_SECONDS;
      this.addHitstop(0.07);
    }

    if (run.shield > 0) {
      const absorbed = Math.min(run.shield, dmg);
      run.shield -= absorbed;
      dmg -= absorbed;
      this.synth.shieldHit();
      this.spawnRing(this.ship.x, this.ship.y, 40, COLORS.shield, 0.3);
    }
    if (dmg > 0) {
      run.hull -= dmg;
      this.synth.towerHit();
      this.flash([0.4, 0.06, 0.1], 0.32);
    }
    if (source && s.thorns > 0) this.damageEnemy(source, source.dmg * s.thorns, false, false);
    if (run.hull <= 0 && !run.over) this.endRun();
  }

  endRun() {
    const run = this.state.run;
    run.over = true;
    run.hull = 0;
    // Pay out BEFORE anything else can happen. bankRun() saves, so even a tab
    // that dies right here keeps the Cores.
    const cores = this.state.bankRun();
    this.synth.death();
    this.flash([0.55, 0.1, 0.15], 1.1);
    this.spawnExplosion(this.ship.x, this.ship.y, 30, COLORS.ship, true);
    this.emit('runOver', { wave: run.wave, cores });
  }

  // --- abilities ---------------------------------------------------------------

  useAbility(key) {
    const { run } = this.state;
    if (!this.state.abilityUnlocked(key)) return false;
    if ((run.cooldowns[key] || 0) > 0) { this.synth.denied(); return false; }
    const def = ABILITIES[key];
    run.cooldowns[key] = def.cd;
    this.synth.ability();
    this.emit('ability', { key });

    if (key === 'overdrive') {
      this.buffs.overdrive = def.dur;
      this.flash([0.35, 0.25, 0.05], 0.4);
    } else if (key === 'nova') {
      const power = enemyHP(run.wave) * 5.5 + this.stats.damage * 30;
      for (const e of this.enemies.items) {
        if (!e.active) continue;
        this.damageEnemy(e, power, false, false);
      }
      this.spawnRing(this.ship.x, this.ship.y, Math.max(this.fieldW, this.fieldH), [0.4, 0.9, 1.6], 0.9);
      this.flash([0.2, 0.45, 0.6], 0.85);
    } else if (key === 'aegis') {
      this.buffs.aegis = def.dur;
      run.shield = this.stats.maxShield;
      run.hull = Math.min(this.stats.maxHull, run.hull + this.stats.maxHull * 0.25);
      this.spawnRing(this.ship.x, this.ship.y, 120, [0.4, 1.5, 0.9], 0.8);
    } else if (key === 'singularity') {
      // Opens ahead of the ship and hauls the lane into it.
      this.singularity = { t: def.dur, x: this.ship.x, y: this.y0 + this.fieldH * 0.3 };
      this.buffs.singularity = def.dur;
    } else if (key === 'lance') {
      this.lance = { t: def.dur };
      this.buffs.lance = def.dur;
    }
    this.state.markDirty();
    return true;
  }

  // --- feedback ------------------------------------------------------------------

  /**
   * Randomness for cosmetics only.
   *
   * Wreckage, sparks and smoke draw from here rather than Math.random so that
   * visual work cannot perturb the gameplay stream. Without this, adding an
   * effect re-samples every subsequent gameplay roll and shifts measured run
   * depth by several levels — which looks exactly like a balance regression and
   * is impossible to A/B against.
   */
  fxRandom() {
    let x = this.fxSeed;
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5;  x >>>= 0;
    this.fxSeed = x;
    return x / 4294967296;
  }

  flash(color, amount) {
    if (amount > this.flashAmount) { this.flashAmount = amount; this.flashColor = color; }
  }

  addFloater(x, y, text, color, scale = 1) {
    if (this.floaters.length > 20) this.floaters.shift();
    this.floaters.push({ x, y, text, color, scale, life: 0.9, maxLife: 0.9, vy: -46 });
  }

  spawnParticle(x, y, vx, vy, life, size, color, drag = 0.94, kind = 0) {
    const p = this.particles.obtain();
    p.active = true;
    p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    p.life = p.maxLife = life;
    p.size = size;
    p.r = color[0]; p.g = color[1]; p.b = color[2];
    p.drag = drag; p.kind = kind;
    p.rot = Math.atan2(vy, vx);
    return p;
  }

  spawnMuzzle() {
    const { x, y } = this.ship;
    for (let i = 0; i < 2; i++) {
      const a = -Math.PI / 2 + (this.fxRandom() - 0.5) * 0.8;
      const sp = 90 + this.fxRandom() * 150;
      this.spawnParticle(x, y - 14, Math.cos(a) * sp, Math.sin(a) * sp,
        0.14, 3 + this.fxRandom() * 2.5, COLORS.bullet, 0.88, 1);
    }
  }

  spawnThrust(dt) {
    const ship = this.ship;
    if (this.fxRandom() > dt * 70) return;
    this.spawnParticle(
      ship.x - ship.bank * 8 + (this.fxRandom() - 0.5) * 6, ship.y + 15,
      -ship.vx * 0.2 + (this.fxRandom() - 0.5) * 30,
      130 + this.fxRandom() * 90,
      0.28, 3.5 + this.fxRandom() * 2.5, COLORS.ship, 0.9, 1);
  }

  spawnExplosion(x, y, radius, color, big) {
    const n = big ? 46 : Math.min(18, 7 + Math.floor(radius * 0.55));
    for (let i = 0; i < n; i++) {
      const a = this.fxRandom() * TAU;
      const sp = (big ? 120 : 55) + this.fxRandom() * (big ? 340 : 180);
      this.spawnParticle(x, y, Math.cos(a) * sp, Math.sin(a) * sp,
        0.3 + this.fxRandom() * (big ? 0.7 : 0.35),
        (big ? 5 : 2.5) + this.fxRandom() * (big ? 9 : 4), color, 0.9, 1);
    }
    this.spawnParticle(x, y, 0, 0, big ? 0.35 : 0.16, radius * (big ? 3.4 : 1.9), color, 1, 2);
  }

  /**
   * Break a dying craft into its own silhouette.
   *
   * Each structural part of the recipe becomes an independent body carrying the
   * craft's momentum plus an outward impulse, so a Juggernaut sheds five plates
   * where a Drone sheds three struts — the death shows you what the thing was
   * built from. `alt` falls 1 -> 0 and shrinks the piece, which reads as it
   * dropping away from the camera towards the water.
   *
   * Skipped for small craft: a cloud of chaff producing forty tumbling parts is
   * noise rather than spectacle, and it is the worst case for fill rate.
   */
  spawnWreckage(e) {
    if (e.radius < 9 || e.ground) return;
    const bodies = craftBodies(e.type);
    const f = e.face || 0;
    const cos = Math.cos(f), sin = Math.sin(f);
    const sc = e.radius;
    const wear = 0.5 + 0.3 * this.fxRandom();

    for (const bd of bodies) {
      const w = this.wrecks.obtain();
      w.active = true;
      // Local -> world for the part's centre.
      const lx = bd.cx * sc, ly = bd.cy * sc;
      w.x = e.x + lx * cos - ly * sin;
      w.y = e.y + lx * sin + ly * cos;

      const ox = w.x - e.x, oy = w.y - e.y;
      const od = Math.hypot(ox, oy) || 1;
      const push = 40 + this.fxRandom() * 90;
      w.vx = (e.vx || 0) * 0.6 + (ox / od) * push + (this.fxRandom() - 0.5) * 40;
      w.vy = (e.vy || 0) * 0.6 + (oy / od) * push + (this.fxRandom() - 0.5) * 40;
      // Pieces thrown from further off-centre tumble harder.
      w.spin = (this.fxRandom() - 0.5) * 6 * (0.4 + od / (sc * 1.6));

      w.angle = f + bd.rot;
      w.rot = bd.rot;
      w.shape = bd.shape;
      w.hw = (bd.hw || 0) * sc;
      w.hh = (bd.hh || 0) * sc;
      w.r0 = (bd.r || 0) * sc;
      w.sides = bd.sides || 4;

      w.alt = 1;
      w.maxLife = w.life = 1.15 + this.fxRandom() * 0.5;
      const m = bd.m * wear;
      w.r = e.color[0] * m; w.g = e.color[1] * m; w.b = e.color[2] * m;
      w.burn = 0.5 + this.fxRandom() * 0.5;
      w.smoke = 0;
    }
  }

  updateWrecks(dt) {
    for (const w of this.wrecks.items) {
      if (!w.active) continue;
      w.life -= dt;
      w.x += w.vx * dt;
      w.y += w.vy * dt;
      // Wreckage keeps pace with the scrolling world so it falls onto the
      // terrain it was actually above, not onto whatever slides under it.
      w.y += this.scrollDelta || 0;
      const d = Math.pow(0.35, dt);
      w.vx *= d; w.vy *= d;
      w.angle += w.spin * dt;
      w.spin *= Math.pow(0.5, dt);
      w.alt = Math.max(0, w.life / w.maxLife);

      if (w.burn > 0 && this.fxRandom() < dt * 26) {
        this.spawnParticle(w.x, w.y, (this.fxRandom() - 0.5) * 30,
          (this.fxRandom() - 0.5) * 30 - 20, 0.35 + this.fxRandom() * 0.3,
          2 + this.fxRandom() * 3, [0.55, 0.5, 0.48], 0.9, 1);
      }

      if (w.life <= 0 || w.y > this.y1 + 40) {
        w.active = false;
        if (w.life <= 0 && w.y < this.y1 + 40) this.wreckImpact(w);
      }
    }
  }

  /**
   * The moment the terrain stops being a backdrop and becomes a place: debris
   * that lands on water throws a splash, debris that lands on rock scorches it.
   */
  wreckImpact(w) {
    const size = Math.max(w.hh, w.r0, 4);
    if (this.terrain.surfaceAt(w.x, w.y) === 'water') {
      this.spawnRing(w.x, w.y, size * 2.2, [0.75, 0.95, 1.1], 0.4);
      this.spawnParticle(w.x, w.y, 0, 0, 0.22, size * 1.5, [0.9, 1.0, 1.1], 1, 2);
      const n = 4 + ((this.fxRandom() * 3) | 0);
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (this.fxRandom() - 0.5) * 2.2;
        const sp = 50 + this.fxRandom() * 90;
        this.spawnParticle(w.x, w.y, Math.cos(a) * sp, Math.sin(a) * sp,
          0.3, 1.5 + this.fxRandom() * 2, [0.8, 0.95, 1.1], 0.92, 1);
      }
      this.synth.splash();
    } else {
      this.spawnParticle(w.x, w.y, 0, 0, 0.3, size * 1.7, [1.5, 0.7, 0.25], 1, 2);
      for (let i = 0; i < 6; i++) {
        const a = this.fxRandom() * TAU;
        const sp = 30 + this.fxRandom() * 70;
        this.spawnParticle(w.x, w.y, Math.cos(a) * sp, Math.sin(a) * sp,
          0.45 + this.fxRandom() * 0.4, 2.5 + this.fxRandom() * 3,
          [0.42, 0.36, 0.30], 0.9, 1);
      }
      this.spawnRing(w.x, w.y, size * 1.6, [0.5, 0.38, 0.28], 0.55);
      this.synth.thud();
    }
  }

  renderWrecks() {
    const R = this.renderer;
    for (const w of this.wrecks.items) {
      if (!w.active) continue;
      // Shrinking with altitude is what sells the fall on a flat 2D plane.
      const k = 0.55 + 0.45 * w.alt;
      const a = Math.min(1, w.alt * 2.2);
      if (w.shape === 'gon') {
        R.polyLit(w.x, w.y, w.r0 * k, w.sides, w.angle, w.r, w.g, w.b, a, 0.9);
      } else {
        R.slabLit(w.x, w.y, w.hw * k, w.hh * k, w.angle, w.r, w.g, w.b, a, 0.85);
      }
      if (w.burn > 0) {
        const heat = w.burn * w.alt;
        R.glow(w.x, w.y, Math.max(w.hh, w.r0) * 1.5 * k,
          1.5, 0.55 + 0.3 * heat, 0.2, 0.3 * heat, 1.8);
      }
    }
  }

  spawnRing(x, y, radius, color, life = 0.45) {
    this.spawnParticle(x, y, 0, 0, life, radius, color, 1, 3);
  }

  // --- update -----------------------------------------------------------------

  /**
   * Queue a hitstop.
   *
   * Duration is divided by sqrt(timeScale) because a freeze is measured in real
   * seconds while the world runs faster: a flat 60ms at 4x speed is 240ms of
   * game time and reads as a stutter rather than a hit. The rolling budget
   * stops a screen-clearing Nova from becoming a slideshow — kills over budget
   * still play every other piece of feedback, they just do not stop the clock.
   */
  addHitstop(seconds) {
    let sec = seconds;
    if (this.reducedMotion) sec *= 0.5;
    sec = Math.min(HITSTOP_MAX, sec / Math.sqrt(Math.max(1, this.timeScale)));
    const spend = Math.min(sec, this.freezeBudget);
    if (spend <= 0.0005) return;
    this.freezeBudget -= spend;
    this.freeze = Math.max(this.freeze, spend);
  }

  /** How much this craft's death is worth interrupting the game for. */
  killWeight(e) {
    const base = enemyHP(this.state.run.wave) || 1;
    return Math.max(0, Math.min(1, e.maxHp / (base * 2.5)));
  }

  update(dtRaw) {
    if (this.paused || this.state.run.over) { this.decayFeedback(dtRaw); return; }

    // Held frame. Shake and flash keep animating so it reads as a deliberate
    // beat; a completely static frame just looks like a dropped one.
    if (this.freeze > 0) {
      this.freeze -= dtRaw;
      this.decayFeedback(dtRaw);
      return;
    }
    this.freezeBudget = Math.min(FREEZE_BUDGET, this.freezeBudget + dtRaw * FREEZE_BUDGET);

    let scale = this.timeScale;
    if (this.slowmo > 0) {
      this.slowmo = Math.max(0, this.slowmo - dtRaw);
      // Ease back to normal rather than snapping — the ramp is the victory lap.
      const k = 1 - this.slowmo / SLOWMO_DUR;
      scale *= SLOWMO_MIN + (1 - SLOWMO_MIN) * k * k;
    }
    this._knocks = 0;

    const dt = Math.min(0.05, dtRaw) * scale;
    const { run } = this.state;
    run.elapsed += dt;

    this.updateBuffs(dt);
    this.updateBackdrop(dt);
    this.updateHazards(dt);
    this.updateWave(dt);
    this.updateBeams(dt);
    this.target = this.acquireTarget();
    this.steer(dt);
    this.spawnThrust(dt);
    this.fire(dt);
    this.updateBullets(dt);
    this.updateWards();
    this.updateEnemies(dt);
    this.updateWingmen(dt);
    this.updateSystems(dt);
    this.updatePickups(dt);
    this.updateWrecks(dt);
    this.updateParticles(dt);
    this.updateFloaters(dt);
    this.updateRegen(dt);
    this.decayFeedback(dtRaw);
  }

  updateBuffs(dt) {
    for (const k of Object.keys(this.buffs)) {
      this.buffs[k] -= dt;
      if (this.buffs[k] <= 0) {
        delete this.buffs[k];
        if (k === 'singularity') this.singularity = null;
        if (k === 'lance') this.lance = null;
      }
    }
    const cds = this.state.run.cooldowns;
    for (const k of Object.keys(cds)) if (cds[k] > 0) cds[k] = Math.max(0, cds[k] - dt);
    if (this.singularity) this.singularity.t -= dt;
    if (this.lance) this.lance.t -= dt;
  }

  updateHazards(dt) {
    const sec = this.sector;
    const scroll = this.scrollSpeed * (sec.scrollMult || 1);

    // Drifting rock. Purely a hazard — it never blocks your shots, so it is
    // spectacle and dodging practice rather than a damage check.
    if (sec.debris > 0 && Math.random() < dt * sec.debris * 0.17) this.spawnDebris();
    for (const d of this.debris.items) {
      if (!d.active) continue;
      d.y += scroll * d.vy * dt;
      d.angle += d.spin * dt;
      if (d.flash > 0) d.flash -= dt;
      if (d.y - d.r > this.y1 + 40) { d.active = false; continue; }
      const dx = this.ship.x - d.x, dy = this.ship.y - d.y;
      if (Math.hypot(dx, dy) < d.r + this.ship.radius) {
        this.damageShip(enemyDamage(this.state.run.wave) * 0.7 * TUNING.CONTACT_SCALE, null);
        this.breakDebris(d);
      }
    }

    // Ion Storm: an arc sweeps the lane and stuns whatever it crosses. A
    // benefit to the player, offsetting the zone's faster enemies.
    if (sec.effect === 'storm') {
      this.stormTimer -= dt;
      if (!this.storm && this.stormTimer <= 0) {
        this.storm = { t: 0.55, y: this.y0 + Math.random() * this.fieldH * 0.8, seed: Math.random() * 1000 };
        this.stormTimer = 5 + Math.random() * 5;
        this.flash([0.25, 0.4, 0.7], 0.5);
        this.synth.ability();
        for (const e of this.enemies.items) {
          if (!e.active || e.boss) continue;
          if (Math.abs(e.y - this.storm.y) < 90) e.stun = 1.3;
        }
      }
      if (this.storm) { this.storm.t -= dt; if (this.storm.t <= 0) this.storm = null; }
    }
  }

  updateWave(dt) {
    if (!this.waveActive) {
      this.interWave -= dt;
      if (this.interWave <= 0) this.startWave();
      return;
    }

    // Anti-stall. Hovering shooters hold at range rather than closing, so a
    // ship with strong regen but not enough damage could sit in one wave
    // forever — neither winning nor dying. After ENRAGE_AFTER the survivors
    // wind up, without limit. The standoff always resolves.
    this.waveTime += dt;
    if (this.waveTime > ENRAGE_AFTER) {
      const prev = this.enrage;
      this.enrage = (this.waveTime - ENRAGE_AFTER) / 30;
      if (prev === 0) {
        this.emit('enrage', { wave: this.state.run.wave });
        this.flash([0.4, 0.1, 0.1], 0.5);
      }
    }

    this.spawnTimer -= dt;
    while (this.spawnQueue.length && this.spawnTimer <= 0) {
      this.spawnFormation();
      this.spawnTimer += this.spawnInterval;
    }
    if (!this.spawnQueue.length) {
      let anyAlive = false;
      for (const e of this.enemies.items) if (e.active) { anyAlive = true; break; }
      if (!anyAlive) this.completeWave();
    }
  }

  updateBullets(dt) {
    const items = this.bullets.items;
    const enemies = this.enemies.items;
    for (let i = 0; i < items.length; i++) {
      const b = items[i];
      if (!b.active) continue;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;
      if (b.life <= 0 || b.y < this.y0 - 60 || b.y > this.y1 + 60 ||
          b.x < this.x0 - 60 || b.x > this.x1 + 60) {
        b.active = false;
        continue;
      }

      if (b.fromEnemy) {
        if (b.drag > 0) {
          const k = Math.pow(b.drag, dt);
          b.vx *= k; b.vy *= k;
          const sp = Math.hypot(b.vx, b.vy);
          if (sp < b.minSpeed && sp > 0.01) {
            b.vx = (b.vx / sp) * b.minSpeed;
            b.vy = (b.vy / sp) * b.minSpeed;
          }
        }
        if (b.homing > 0) {
          const hx = this.ship.x - b.x, hy = this.ship.y - b.y;
          const hd = Math.hypot(hx, hy) || 1;
          const sp = Math.hypot(b.vx, b.vy) || 1;
          const k = Math.min(1, b.homing * dt);
          b.vx += ((hx / hd) * sp - b.vx) * k;
          b.vy += ((hy / hd) * sp - b.vy) * k;
        }
        const dx = b.x - this.ship.x, dy = b.y - this.ship.y;
        if (dx * dx + dy * dy < (this.ship.radius + b.radius) ** 2) {
          b.active = false;
          this.damageShip(b.dmg, null);
        }
        continue;
      }

      let consumed = false;
      for (const d of this.debris.items) {
        if (!d.active || b.hits.has(d)) continue;
        const ddx = d.x - b.x, ddy = d.y - b.y;
        if (ddx * ddx + ddy * ddy <= (d.r + b.radius) ** 2) {
          b.hits.add(d);
          d.hp -= b.dmg;
          d.flash = 0.1;
          this.spawnParticle(b.x, b.y, (Math.random() - 0.5) * 90, (Math.random() - 0.5) * 90,
            0.18, 2.5, COLORS.debris, 0.9, 1);
          if (d.hp <= 0) this.breakDebris(d);
          if (--b.pierce <= 0) { b.active = false; consumed = true; }
          break;
        }
      }
      if (consumed) continue;

      if (b.homing > 0) {
        // Player ordnance hunts the nearest live target.
        let tx = null, td = 1e9;
        for (const e of enemies) {
          if (!e.active) continue;
          const d = Math.hypot(e.x - b.x, e.y - b.y);
          if (d < td) { td = d; tx = e; }
        }
        if (tx) {
          const hx = tx.x - b.x, hy = tx.y - b.y;
          const hd = Math.hypot(hx, hy) || 1;
          const sp = Math.hypot(b.vx, b.vy) || 1;
          const k = Math.min(1, b.homing * dt);
          b.vx += ((hx / hd) * sp - b.vx) * k;
          b.vy += ((hy / hd) * sp - b.vy) * k;
        }
        // Dense exhaust: the trail is what makes a missile read as a missile.
        if (Math.random() < dt * 90) {
          this.spawnParticle(b.x - b.vx * 0.02, b.y - b.vy * 0.02,
            -b.vx * 0.12 + (Math.random() - 0.5) * 40,
            -b.vy * 0.12 + (Math.random() - 0.5) * 40,
            0.42, 4.4, COLORS.missile, 0.92, 1);
        }
      }

      for (let j = 0; j < enemies.length; j++) {
        const e = enemies[j];
        if (!e.active || b.hits.has(e)) continue;
        if (e.phase && Math.sin(e.phaseT) > 0.55) continue;
        const dx = e.x - b.x, dy = e.y - b.y;
        const rr = e.radius + b.radius;
        if (dx * dx + dy * dy <= rr * rr) {
          b.hits.add(e);
          const bs = Math.hypot(b.vx, b.vy) || 1;
          const frac = Math.min(1, b.dmg / (e.maxHp || 1));
          this.damageEnemy(e, b.dmg, b.crit, true, [b.vx / bs, b.vy / bs]);
          this.synth.hit();
          const sparks = 1 + Math.round(6 * frac);
          for (let k = 0; k < sparks; k++) {
            const a = this.fxRandom() * TAU;
            const sp = 40 + this.fxRandom() * (90 + 260 * frac);
            this.spawnParticle(b.x, b.y, Math.cos(a) * sp, Math.sin(a) * sp,
              0.18 + frac * 0.14, 2 + this.fxRandom() * (2 + 3 * frac), e.color, 0.9, 1);
          }
          if (b.missile) {
            this.spawnExplosion(b.x, b.y, 13, COLORS.missile, false);
            if (b.split > 0) this.splitWarhead(b);
            b.active = false;
            break;
          }
          if (--b.pierce <= 0) { b.active = false; break; }
        }
      }
    }
  }

  /**
   * Wardens project a damage-reduction field over nearby craft.
   *
   * A support enemy gives a wave a shape: without one you shoot whatever is
   * closest, with one there is a right answer. Recomputed per frame from the
   * live warden set so killing the warden drops the shelter immediately.
   */
  updateWards() {
    const items = this.enemies.items;
    let any = false;
    for (const w of items) if (w.active && w.aura > 0) { any = true; break; }
    if (!any) {
      for (const e of items) if (e.warded) e.warded = 0;
      return;
    }
    for (const e of items) {
      if (!e.active) continue;
      e.warded = 0;
      if (e.aura > 0) continue;
      for (const w of items) {
        if (!w.active || w.aura <= 0 || w === e) continue;
        if (Math.hypot(e.x - w.x, e.y - w.y) <= w.aura) { e.warded = 1; break; }
      }
    }
  }

  updateEnemies(dt) {
    const s = this.stats;
    const ship = this.ship;
    const items = this.enemies.items;
    const sing = this.singularity;
    const enrageMul = 1 + this.enrage * 1.5;
    const regen = this.sector.enemyRegen || 0;

    for (let i = 0; i < items.length; i++) {
      const e = items[i];
      if (!e.active) continue;
      e.lastX = e.x;
      e.t += dt;
      if (e.hitFlash > 0) e.hitFlash -= dt;
      if (e.hitPower > 0) e.hitPower = Math.max(0, e.hitPower - dt * 4);

      // Recoil offset springs back fast, so a shove reads as a jolt rather
      // than as the craft being blown off course.
      if (e.kx !== 0 || e.ky !== 0) {
        const decay = Math.pow(0.0004, dt);
        e.kx *= decay; e.ky *= decay;
        if (Math.abs(e.kx) < 0.05) e.kx = 0;
        if (Math.abs(e.ky) < 0.05) e.ky = 0;
      }
      if (e.phase) e.phaseT += dt * 2.6;
      if (regen > 0 && e.hp < e.maxHp) e.hp = Math.min(e.maxHp, e.hp + e.maxHp * regen * dt);

      // Wounded craft stream smoke — condition you can read across the lane.
      const frac = e.hp / (e.maxHp || 1);
      if (frac < 0.55) {
        e.smokeT -= dt;
        if (e.smokeT <= 0) {
          e.smokeT = 0.05 + frac * 0.14;
          const dark = frac < 0.28;
          this.spawnParticle(
            e.x + (Math.random() - 0.5) * e.radius, e.y - e.radius * 0.3,
            (Math.random() - 0.5) * 26, -34 - Math.random() * 34,
            0.55 + Math.random() * 0.4, 4 + Math.random() * 4,
            dark ? [0.16, 0.15, 0.16] : [0.30, 0.29, 0.30], 0.95, 1);
        }
      }

      if (e.stun > 0) {
        e.stun -= dt;
        e.angle += dt * 9;
        if (Math.random() < dt * 12) {
          this.spawnParticle(e.x, e.y, (Math.random() - 0.5) * 90, (Math.random() - 0.5) * 90,
            0.16, 2.5, [0.5, 0.8, 1.6], 0.9, 1);
        }
        continue;
      }

      const speed = e.speed * e.distScale * enrageMul;

      if (sing && sing.t > 0) {
        const sdx = sing.x - e.x, sdy = sing.y - e.y;
        const sd = Math.hypot(sdx, sdy) || 0.001;
        const pull = Math.min(560, 22000 / Math.max(40, sd));
        e.x += (sdx / sd) * pull * dt;
        e.y += (sdy / sd) * pull * dt;
        e.angle += dt * 6;
        continue;
      }

      switch (e.behavior) {
        case 'ground': {
          // Fixed to the world: it scrolls, it does not pursue.
          e.y += this.scrollSpeed * (this.sector.scrollMult || 1) * dt;
          e.face = 0;
          break;
        }
        case 'swarm': {
          // Fastest and most direct — a straight ram at where the ship is.
          const dx = ship.x - e.x, dy = ship.y - e.y;
          const d = Math.hypot(dx, dy) || 1;
          e.x += (dx / d) * speed * 1.15 * dt;
          e.y += (dy / d) * speed * 1.15 * dt;
          e.face = Math.atan2(-dx, dy);
          break;
        }
        case 'weave': {
          e.homeX += (ship.x - e.homeX) * 0.28 * dt;
          e.x = e.homeX + Math.sin(e.t * e.freq * 2.2) * e.amp;
          e.y += speed * dt;
          e.face = -Math.cos(e.t * e.freq * 2.2) * 0.45;
          break;
        }
        case 'hover': {
          // Holds station and shoots. Artillery is not trying to reach you.
          if (e.y < e.holdY) e.y += speed * dt;
          else e.x += Math.cos(e.t * 0.9 + e.spin2) * 62 * dt;
          e.face = 0;
          break;
        }
        case 'boss': {
          if (e.y < e.holdY) { e.y += speed * dt; e.face = 0; break; }
          this.runBossPattern(e, dt);
          e.face = 0;
          break;
        }
        default: {
          // 'dive' — descend while leaning toward the ship, ending in a ram.
          const dx = ship.x - e.x;
          e.x += Math.sign(dx) * Math.min(Math.abs(dx), speed * 0.55) * dt;
          e.y += speed * dt;
          e.face = -Math.max(-0.45, Math.min(0.45, dx / 300));
          break;
        }
      }

      // Anything armed shoots, including elites that also ram.
      if (e.weapon && e.y > this.y0 - 10) this.fireWeapon(e, dt);

      if (this.lance && this.lance.t > 0 && Math.abs(e.x - ship.x) < 26) {
        this.damageEnemy(e, (enemyHP(this.state.run.wave) * 2.2 + s.damage * 8) * dt, false, false);
        if (!e.active) continue;
      }

      // Contact: this is how most enemies "attack" and also how they die.
      const dx = ship.x - e.x, dy = ship.y - e.y;
      if (!e.ground && dx * dx + dy * dy < (ship.radius + e.radius) ** 2) {
        this.damageShip(e.dmg * TUNING.CONTACT_SCALE * (1 + this.enrage * 2), e);
        if (e.active && !e.boss) {
          // A rammer is spent whether or not it killed you; still pays out.
          this.killEnemy(e);
        }
        continue;
      }

      // Anything that slips past is gone — no damage, but no loot either.
      if (e.y - e.radius > this.y1 + 60 && e.behavior !== 'hover' && !e.boss) {
        e.active = false;
      }
    }
  }

  /**
   * Wingmen fire real guns.
   *
   * They used to sit at ship.y + 12 — BELOW the ship, further from the enemy —
   * and apply invisible continuous damage gated by targeting range. Measured
   * over a minute of play that produced exactly zero damage events: the nearest
   * enemy was ~560px away against a 262px range, so they never found a target
   * and there was nothing to see even when they did. Now they fly slightly
   * ahead and shoot actual tracers, which both works and looks like it works.
   */
  wingmanPos(i, count) {
    const side = i % 2 === 0 ? -1 : 1;
    const rank = Math.floor(i / 2);
    return [
      this.ship.x + side * (32 + rank * 22) - this.ship.bank * 10,
      this.ship.y - 2 + rank * 15 + Math.sin(this.wingAngle * 2.2 + i) * 3,
    ];
  }

  updateWingmen(dt) {
    const s = this.stats;
    if (s.drones <= 0) return;
    this.wingAngle += dt;

    const rate = s.fireRate * s.wingRate * (this.buffs.overdrive > 0 ? 2.5 : 1);
    this.wingTimer = (this.wingTimer || 0) - dt;
    if (this.wingTimer > 0) return;
    this.wingTimer += 1 / Math.max(0.1, rate);

    const aim = this.aimAngle();
    for (let i = 0; i < s.drones; i++) {
      const [wx, wy] = this.wingmanPos(i, s.drones);
      const crit = Math.random() < s.critChance;
      const b = this.bullets.obtain();
      b.active = true;
      b.x = wx; b.y = wy - 8;
      b.vx = Math.cos(aim) * 720;
      b.vy = Math.sin(aim) * 720;
      b.dmg = s.damage * (crit ? s.critMult : 1);
      b.crit = crit;
      b.pierce = s.pierce;
      b.life = 2.0;
      b.radius = crit ? 4 : 2.6;
      b.fromEnemy = false;
      b.homing = 0; b.drag = 0; b.missile = false;
      b.system = 'wing';
      b.hits = b.hits || new Set();
      b.hits.clear();
    }
  }

  /**
   * Guns fire straight forward. Always.
   *
   * They used to swing within a wide cone toward whatever was tracked, which
   * quietly did the player's job for them: position stopped mattering because
   * the barrels covered the lane by themselves. Firing straight puts that work
   * back where it belongs — on the autopilot lining the ship up, and on the
   * player when they take the stick.
   *
   * It also gives the weapon systems a reason to exist. Missiles home, the arc
   * coil chains and flak is lobbed; none of them care about facing. A straight
   * gun leaves angles uncovered, and buying a system is how you cover them.
   */
  aimAngle() {
    return -Math.PI / 2;
  }

  // --- auto-firing weapon systems ------------------------------------------

  updateSystems(dt) {
    const s = this.stats;
    if (s.laserDps > 0) this.updateLaser(dt, s);
    if (s.missileDmg > 0) this.updateMissiles(dt, s);
    if (s.flakDmg > 0) this.updateFlak(dt, s);
    if (s.arcDmg > 0) this.updateArc(dt, s);
    this.updateShells(dt);

    for (let i = this.arcs.length - 1; i >= 0; i--) {
      this.arcs[i].t -= dt;
      if (this.arcs[i].t <= 0) this.arcs.splice(i, 1);
    }
  }

  /** Continuous beam welded to whatever the guns are tracking. */
  /** Continuous beam straight up the lane, cutting whatever is in the column. */
  updateLaser(dt, s) {
    const ship = this.ship;
    const half = LASER_HALF_WIDTH + s.laserTier * 6;

    this.laserChain.length = 0;
    for (const e of this.enemies.items) {
      if (!e.active || e.y > ship.y - 6) continue;
      if (e.phase && Math.sin(e.phaseT) > 0.55) continue;
      if (Math.abs(e.x - ship.x) > e.radius + half) continue;
      this.laserChain.push(e);
    }
    // Nearest first, so mastery pierces the front of the column outward.
    this.laserChain.sort((a, b) => b.y - a.y);
    if (this.laserChain.length > s.laserPierce) this.laserChain.length = s.laserPierce;
    this.laserTarget = this.laserChain[0] || null;
    if (!this.laserTarget) return;

    for (const hit of this.laserChain) {
      this.damageEnemy(hit, s.laserDps * dt, false, false);
    }

    this.laserTick -= dt;
    if (this.laserTick <= 0) {
      this.laserTick = 0.45;
      const t = this.laserTarget;
      this.addFloater(t.x, t.y - t.radius, fmtShort(s.laserDps * 0.45), [0.5, 1.4, 1.7], 0.8);
      if (Math.random() < 0.5) this.synth.hit();
    }
    for (const hit of this.laserChain) {
      if (Math.random() > 0.5) continue;
      this.spawnParticle(hit.x + (Math.random() - 0.5) * hit.radius,
        hit.y + (Math.random() - 0.5) * hit.radius,
        (Math.random() - 0.5) * 130, (Math.random() - 0.5) * 130,
        0.16, 2.4, [0.5, 1.4, 1.7], 0.9, 1);
    }
  }

  updateMissiles(dt, s) {
    this.sysT.missile -= dt;
    if (this.sysT.missile > 0) return;
    this.sysT.missile += SYSTEM.missileCd;
    for (let i = 0; i < s.missileCount; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const b = this.bullets.obtain();
      b.active = true;
      b.x = this.ship.x + side * 12;
      b.y = this.ship.y + 4;
      // Lobbed outward first, then it turns and hunts — reads as a launch.
      const ang = -Math.PI / 2 + side * (0.7 + Math.random() * 0.35);
      // Launched slowly and sideways so the arc-over is actually watchable;
      // homing then hauls them onto the target.
      b.vx = Math.cos(ang) * 170;
      b.vy = Math.sin(ang) * 170;
      b.dmg = s.missileDmg;
      b.crit = false;
      b.pierce = 1;
      b.life = 4.5;
      b.radius = 6.5;
      b.fromEnemy = false;
      b.system = 'missile';
      b.homing = 2.6;
      b.drag = 0;
      b.missile = true;
      b.split = s.missileTier;
      b.hits = b.hits || new Set();
      b.hits.clear();
      // Launch puff, so a salvo announces itself.
      for (let k = 0; k < 4; k++) {
        this.spawnParticle(b.x, b.y, Math.cos(ang) * -90 + (Math.random() - 0.5) * 70,
          Math.sin(ang) * -90 + (Math.random() - 0.5) * 70, 0.25,
          3.5, COLORS.missile, 0.9, 1);
      }
    }
    this.synth.ability();
  }

  /** Airburst over the thickest part of the swarm. */
  updateFlak(dt, s) {
    this.sysT.flak -= dt;
    if (this.sysT.flak > 0) return;

    let best = null, bestScore = -1;
    for (const e of this.enemies.items) {
      // Only skip craft still fully off-screen; excluding everything above y0
      // meant flak ignored the entire entering formation.
      if (!e.active || e.y < this.y0 - 30) continue;
      let n = 0;
      for (const o of this.enemies.items) {
        if (!o.active) continue;
        if (Math.hypot(o.x - e.x, o.y - e.y) < s.flakRadius) n++;
      }
      if (n > bestScore) { bestScore = n; best = e; }
    }
    if (!best) return;
    this.sysT.flak += SYSTEM.flakCd;

    // Lob a visible shell that travels to the target, then bursts. Detonating
    // instantly at a distant point read as a random flash with no cause.
    // A mastered battery walks a barrage across the formation rather than
    // dropping a single shell on it.
    const shots = s.flakBursts || 1;
    for (let i = 0; i < shots; i++) {
      const spread = shots > 1 ? (i - (shots - 1) / 2) * s.flakRadius * 0.85 : 0;
      this.shells.push({
        x: this.ship.x, y: this.ship.y - 10,
        x0: this.ship.x, y0: this.ship.y - 10,
        tx: best.x + spread, ty: best.y + (Math.random() - 0.5) * 30,
        t: -i * 0.09, dur: 0.34, dmg: s.flakDmg, radius: s.flakRadius,
      });
    }
    this.synth.shot(0.45);
  }

  /**
   * Boss behaviour, one routine per roster entry.
   *
   * The point of separate patterns is that each level's boss should demand a
   * different answer: a spiral wants you circling, a sweep wants you slipping
   * through gaps, a carrier wants you killing escorts first. Without that, every
   * boss is the same fight wearing a different hull.
   */
  runBossPattern(e, dt) {
    const def = e.bossDef;
    const pattern = def ? def.pattern : 'spiral';
    const ship = this.ship;
    e.fireT -= dt;

    switch (pattern) {
      case 'sweep': {
        // Paces the lane and fires fans across its own heading.
        e.x = this.cx + Math.sin(e.t * 0.75) * this.fieldW * 0.34;
        if (e.fireT <= 0) {
          e.fireT = 1.5;
          const lean = Math.cos(e.t * 0.75) * 0.32;
          for (let k = -3; k <= 3; k++) {
            this.enemyShot(e, Math.PI / 2 + lean + k * 0.17, { speed: 250, dmg: 0.30, life: 7 });
          }
        }
        break;
      }
      case 'launch': {
        // Sends escorts, then covering missiles. Kill the flights or drown.
        e.x = this.cx + Math.sin(e.t * 0.4) * this.fieldW * 0.26;
        if (e.fireT <= 0) {
          e.fireT = 2.6;
          if (Math.floor(e.t / 2.6) % 2 === 0) {
            for (let k = -1; k <= 1; k++) this.spawnEscort(e, k * 44, 'darter', 0.035, 'swarm');
            this.synth.ability();
          } else {
            for (let k = -1; k <= 1; k++) {
              const b = this.enemyShot(e, Math.PI / 2 + k * 0.3, { speed: 150, dmg: 0.55, life: 8 });
              b.homing = 1.5;
            }
          }
        }
        break;
      }
      case 'lance': {
        // Charges rail columns. They telegraph, so the lane stays readable.
        e.x = this.cx + Math.sin(e.t * 0.5) * this.fieldW * 0.3;
        if (e.fireT <= 0) {
          e.fireT = 3.4;
          for (const off of [-1, 1]) {
            this.beams.push({ x: e.x + off * 62, y: e.y, t: 0, dmg: e.dmg * 0.5, owner: null, w: 30 });
          }
        }
        break;
      }
      case 'swarm': {
        // Spits splitters that multiply if ignored.
        e.x = this.cx + Math.sin(e.t * 0.6) * this.fieldW * 0.28;
        if (e.fireT <= 0) {
          e.fireT = 2.2;
          for (let k = -1; k <= 1; k += 2) this.spawnEscort(e, k * 30, 'splitter', 0.05, 'weave');
        }
        break;
      }
      case 'burst': {
        // Nearly stationary; expanding rings you have to be outside of.
        e.x = this.cx + Math.sin(e.t * 0.18) * this.fieldW * 0.1;
        if (e.fireT <= 0) {
          e.fireT = 2.4;
          e.spin2 += 0.28;
          for (let k = 0; k < 14; k++) {
            this.enemyShot(e, e.spin2 + (k / 14) * TAU, { speed: 190, dmg: 0.26, life: 9 });
          }
          this.spawnRing(e.x, e.y, 130, def ? def.accent : [1.4, 0.5, 1.4], 0.5);
        }
        break;
      }
      default: {
        // 'spiral' — rotating batteries, plus aimed shells to punish camping.
        e.x = this.cx + Math.sin(e.t * 0.3) * this.fieldW * 0.2;
        if (e.fireT <= 0) {
          e.fireT = 1.15;
          e.spin2 += 0.42;
          for (let k = 0; k < 6; k++) {
            this.enemyShot(e, e.spin2 + (k / 6) * TAU, { speed: 215, dmg: 0.26, life: 8 });
          }
          if (Math.floor(e.t) % 3 === 0) {
            this.enemyShot(e, Math.atan2(ship.y - e.y, ship.x - e.x),
              { speed: 320, dmg: 0.42, life: 6 });
          }
        }
        break;
      }
    }
  }

  /** A boss-launched minion. Cheap in HP and payout; it is pressure, not loot. */
  spawnEscort(boss, dx, type, hpShare, behavior) {
    const h = hullFor(type);
    const e = this.enemies.obtain();
    Object.assign(e, {
      active: true, x: boss.x + dx, y: boss.y + 20,
      hp: boss.maxHp * hpShare, maxHp: boss.maxHp * hpShare,
      speed: enemySpeed(this.state.run.wave) * (behavior === 'swarm' ? 1.2 : 0.85),
      dmg: boss.dmg * 0.2, coin: boss.coin * 0.02,
      radius: type === 'splitter' ? 13 : 10, sides: type === 'splitter' ? 5 : 3,
      type, hull: h.hull, accent: h.accent, color: h.hull,
      behavior, boss: false, elite: false, ground: false, bossDef: null,
      weapon: null, wcd: 0, shield: 0, maxShield: 0, phase: false, phaseT: 0,
      splits: type === 'splitter' ? 1 : 0, hitFlash: 0, stun: 0, t: 0, face: 0,
      distScale: 1, smokeT: 0, spin2: 0, homeX: boss.x, amp: 45, freq: 1,
    });
    return e;
  }

  /** Cluster munitions: a mastered warhead scatters live submunitions. */
  splitWarhead(b) {
    const n = 2 + b.split;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + Math.random();
      const sub = this.bullets.obtain();
      sub.active = true;
      sub.x = b.x; sub.y = b.y;
      sub.vx = Math.cos(a) * 220;
      sub.vy = Math.sin(a) * 220;
      sub.dmg = b.dmg * 0.42;
      sub.crit = false;
      sub.pierce = 1;
      sub.life = 1.3;
      sub.radius = 4;
      sub.fromEnemy = false;
      sub.system = 'missile';
      sub.homing = 2.2;
      sub.missile = true;
      sub.split = 0;
      sub.hits = sub.hits || new Set();
      sub.hits.clear();
    }
  }

  /** Flak shells in flight, and their airbursts. */
  updateShells(dt) {
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const sh = this.shells[i];
      sh.t += dt;
      if (sh.t < 0) continue;            // staggered launch
      const k = Math.min(1, sh.t / sh.dur);
      sh.x = sh.x0 + (sh.tx - sh.x0) * k;
      sh.y = sh.y0 + (sh.ty - sh.y0) * k;
      if (Math.random() < dt * 60) {
        this.spawnParticle(sh.x, sh.y, (Math.random() - 0.5) * 50, (Math.random() - 0.5) * 50,
          0.22, 3, COLORS.flak, 0.9, 1);
      }
      if (k < 1) continue;

      let hit = 0;
      for (const e of this.enemies.items) {
        if (!e.active) continue;
        if (Math.hypot(e.x - sh.x, e.y - sh.y) > sh.radius) continue;
        this.damageEnemy(e, sh.dmg, false, false);
        hit++;
      }
      // Two rings plus shrapnel: the burst radius is information, so it is
      // drawn at its real size rather than as a generic puff.
      this.spawnRing(sh.x, sh.y, sh.radius, COLORS.flak, 0.42);
      this.spawnRing(sh.x, sh.y, sh.radius * 0.6, COLORS.flak, 0.28);
      this.spawnExplosion(sh.x, sh.y, 20, COLORS.flak, false);
      for (let n = 0; n < 14; n++) {
        const a = Math.random() * TAU;
        const sp = 150 + Math.random() * 260;
        this.spawnParticle(sh.x, sh.y, Math.cos(a) * sp, Math.sin(a) * sp,
          0.3 + Math.random() * 0.25, 3.2, COLORS.flak, 0.9, 1);
      }
      if (hit) {
        this.addFloater(sh.x, sh.y - 8, fmtShort(sh.dmg) + ' x' + hit, COLORS.flak, 1.05);
      }
      this.synth.kill(false);
      this.shells.splice(i, 1);
    }
  }

  /** Lightning that walks from target to target. */
  updateArc(dt, s) {
    this.sysT.arc -= dt;
    if (this.sysT.arc > 0) return;

    const live = this.enemies.items.filter((e) => e.active && e.y > this.y0 - 20);
    if (!live.length) return;

    // Seed on whatever the guns are tracking. Chaining outward from the ship
    // failed entirely whenever the swarm held station up the lane, because the
    // first hop had to clear a ship-centric distance test.
    let seed = this.target && this.target.active ? this.target : null;
    if (!seed) {
      let bd = 1e9;
      for (const e of live) {
        const d = Math.hypot(e.x - this.ship.x, e.y - this.ship.y);
        if (d < bd) { bd = d; seed = e; }
      }
    }
    if (!seed) return;
    this.sysT.arc += SYSTEM.arcCd;

    const points = [{ x: this.ship.x, y: this.ship.y - 10 }];
    const used = new Set();
    let from = seed;
    used.add(seed);
    this.damageEnemy(seed, s.arcDmg, false, false);
    points.push({ x: seed.x, y: seed.y });

    for (let j = 1; j < s.arcJumps; j++) {
      let best = null, bestD = 190;
      for (const e of live) {
        if (used.has(e) || !e.active) continue;
        const d = Math.hypot(e.x - from.x, e.y - from.y);
        if (d < bestD) { bestD = d; best = e; }
      }
      if (!best) break;
      used.add(best);
      this.damageEnemy(best, s.arcDmg, false, false);
      points.push({ x: best.x, y: best.y });
      from = best;
    }
    if (points.length > 1) {
      this.arcs.push({ points, t: 0.22, max: 0.22 });
      this.synth.shieldHit();
    }

    // A forked coil runs a second, independent chain — the reason a deep arc
    // build clears a screen instead of a line.
    if (s.arcForks > 1) {
      const alt = [{ x: this.ship.x, y: this.ship.y - 10 }];
      let from2 = null;
      for (const e of live) {
        if (used.has(e)) continue;
        from2 = e; break;
      }
      if (from2) {
        used.add(from2);
        this.damageEnemy(from2, s.arcDmg * 0.8, false, false);
        alt.push({ x: from2.x, y: from2.y });
        for (let j = 1; j < s.arcJumps; j++) {
          let best2 = null, bd = 190;
          for (const e of live) {
            if (used.has(e) || !e.active) continue;
            const d = Math.hypot(e.x - from2.x, e.y - from2.y);
            if (d < bd) { bd = d; best2 = e; }
          }
          if (!best2) break;
          used.add(best2);
          this.damageEnemy(best2, s.arcDmg * 0.8, false, false);
          alt.push({ x: best2.x, y: best2.y });
          from2 = best2;
        }
        if (alt.length > 1) this.arcs.push({ points: alt, t: 0.22, max: 0.22 });
      }
    }

    // Mastered coils leave targets stunned.
    if (s.arcTier >= 1) {
      for (const e of used) if (e.active && !e.boss) e.stun = Math.max(e.stun, 0.35);
    }
  }

  updatePickups(dt) {
    const { run } = this.state;
    const s = this.stats;
    const ship = this.ship;
    const magnet = s.magnet;
    const scroll = this.scrollSpeed * (this.sector.scrollMult || 1);

    for (const p of this.pickups.items) {
      if (!p.active) continue;
      p.life -= dt;
      p.angle += p.spin * dt;

      const dx = ship.x - p.x, dy = ship.y - p.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d < magnet) {
        // Accelerating haul-in feels far better than a constant drag.
        const pull = 900 * (1 - d / magnet) + 260;
        p.vx += (dx / d) * pull * dt;
        p.vy += (dy / d) * pull * dt;
      } else {
        p.vy += scroll * 0.35 * dt;        // otherwise it drifts with the world
      }
      p.vx *= Math.pow(0.35, dt);
      p.vy *= Math.pow(0.35, dt);
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      if (d < ship.radius + 12) {
        p.active = false;
        if (p.kind === 'coin') {
          const gained = p.value * s.coinMult;
          run.coins += gained;
          if (gained >= 1 && Math.random() < 0.1) {
            this.addFloater(p.x, p.y, '+' + fmtShort(gained), COLORS.coin, 0.8);
          }
          this.synth.click();
        } else if (p.kind === 'repair') {
          const heal = s.maxHull * p.value;
          run.hull = Math.min(s.maxHull, run.hull + heal);
          this.addFloater(p.x, p.y, '+' + fmtShort(heal) + ' HULL', COLORS.repair, 1.1);
          this.spawnRing(ship.x, ship.y, 46, COLORS.repair, 0.4);
          this.synth.upgrade();
        }
        this.state.markDirty();
        continue;
      }

      if (p.life <= 0 || p.y > this.y1 + 40) p.active = false;
    }
  }

  updateParticles(dt) {
    for (const p of this.particles.items) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) { p.active = false; continue; }
      if (p.kind !== 3) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const d = Math.pow(p.drag, dt * 60);
        p.vx *= d; p.vy *= d;
      }
    }
  }

  updateFloaters(dt) {
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.life -= dt;
      f.y += f.vy * dt;
      f.vy *= 0.94;
      if (f.life <= 0) this.floaters.splice(i, 1);
    }
  }

  updateRegen(dt) {
    const { run } = this.state;
    const s = this.stats;
    if (run.iframe > 0) run.iframe = Math.max(0, run.iframe - dt);
    // Spawn protection. Forward Deploy drops the ship into a live level, and
    // without a moment to settle a bad opening ends the run before the player
    // has seen it.
    if (run.spawnGuard > 0) run.spawnGuard = Math.max(0, run.spawnGuard - dt);

    // Low-hull warning: an accelerating pulse and tone, so a run never simply
    // stops without the player having seen it coming.
    const frac = run.hull / s.maxHull;
    if (frac < 0.32 && !run.over) {
      this.warnT = (this.warnT || 0) - dt;
      if (this.warnT <= 0) {
        this.warnT = 0.28 + frac * 1.4;
        this.flash([0.55, 0.05, 0.09], 0.26);
        this.synth.denied();
      }
    } else {
      this.warnT = 0;
    }

    if (run.hull < s.maxHull) run.hull = Math.min(s.maxHull, run.hull + s.regen * dt);
    if (run.shield < s.maxShield) run.shield = Math.min(s.maxShield, run.shield + s.shieldRegen * dt);
  }

  decayFeedback(dt) {
    this.flashAmount *= Math.pow(0.0009, dt);
    if (this.flashAmount < 0.002) this.flashAmount = 0;
  }

  // --- render -------------------------------------------------------------------

  render(time) {
    const R = this.renderer;
    const s = this.stats;
    const { run } = this.state;
    R.begin();

    R.flash[0] = this.flashColor[0] * this.flashAmount;
    R.flash[1] = this.flashColor[1] * this.flashAmount;
    R.flash[2] = this.flashColor[2] * this.flashAmount;

    const pal = groundFor(this.sector.id);
    this.terrain.renderWater(R, pal, time, this.x0, this.x1, this.y0, this.y1, this.scroll);
    this.renderBackdrop(time);
    this.terrain.render(R, pal, time, this.y0, this.y1);
    this.renderDebris();
    this.renderWrecks();
    this.renderPickups(time);
    this.renderEnemies(time);
    this.renderSystems(time);
    this.renderBeams(time);
    this.renderBullets();
    this.renderParticles();
    this.renderAbilityFX(time);
    this.renderShip(time, run, s);

    R.flush(this.sector.bg);
  }

  renderBackdrop(time) {
    const R = this.renderer;
    const haze = this.sector.haze;
    const tint = this.sector.starTint;

    for (const n of this.nebulae) {
      R.glow(n.x, n.y, n.r, haze[0], haze[1], haze[2], n.a * 0.75, 2.6);
    }
    for (const layer of this.layers) {
      for (const st of layer.stars) {
        // Near stars streak with the motion; far ones stay points. Cheap, and
        // it is most of what sells forward flight.
        // Now that the lane is water and land, these read as spray and speed
        // glints rather than stars — kept faint so they never fight the terrain.
        if (layer.depth > 0.9) {
          R.push(5, st.x, st.y, st.r * 0.8, st.r * 5.0, 0,
            tint[0], tint[1], tint[2], st.a * 0.35, 0, 0);
        } else {
          R.glow(st.x, st.y, st.r * 2.0, tint[0], tint[1], tint[2], st.a * 0.18, 2.2);
        }
      }
    }

    if (this.storm) {
      const k = this.storm.t / 0.55;
      const y = this.storm.y;
      let px = this.x0;
      let py = y;
      for (let i = 1; i <= 14; i++) {
        const nx = this.x0 + (this.fieldW / 14) * i;
        const ny = y + Math.sin(i * 2.7 + this.storm.seed) * 34;
        R.beam(px, py, nx, ny, 3.2 * k, 0.6, 0.9, 1.8, k, 0.8);
        R.beam(px, py, nx, ny, 1.1 * k, 1.7, 1.9, 2.0, k, 0.5);
        px = nx; py = ny;
      }
      R.glow(this.cx, y, this.fieldW * 0.6, 0.4, 0.7, 1.5, k * 0.18, 2.2);
    }
  }

  renderDebris() {
    const R = this.renderer;
    const c = COLORS.debris;
    for (const d of this.debris.items) {
      if (!d.active) continue;
      const hit = d.flash > 0 ? 1.6 : 0;
      const frac = d.maxHp ? Math.max(0, d.hp / d.maxHp) : 1;
      R.glow(d.x, d.y, d.r * 2.1, c[0] + hit, c[1] + hit, c[2] + hit, 0.16, 2.2);
      R.poly(d.x, d.y, d.r, d.sides, d.angle, c[0] + hit, c[1] + hit, c[2] + hit, 0.9);
      if (frac < 0.999) {
        R.ring(d.x, d.y, d.r + 5, 1.2 * frac, 1.4, 0.7, 0.3, 0.6);
      }
      R.ring(d.x, d.y, d.r * 0.55, 1.2, c[0] * 1.3, c[1] * 1.3, c[2] * 1.4, 0.3);
    }
  }

  renderPickups(time) {
    const R = this.renderer;
    for (const p of this.pickups.items) {
      if (!p.active) continue;
      const fade = p.life < 1.5 ? Math.max(0, p.life / 1.5) : 1;
      const blink = p.life < 1.5 && Math.sin(time * 22) < 0 ? 0.3 : 1;
      if (p.kind === 'coin') {
        const c = COLORS.coin;
        R.glow(p.x, p.y, 15, c[0], c[1], c[2], 0.55 * fade * blink, 1.8);
        R.poly(p.x, p.y, 6.2, 6, p.angle, c[0], c[1], c[2], fade * blink);
      } else {
        const c = COLORS.repair;
        R.glow(p.x, p.y, 22, c[0], c[1], c[2], 0.6 * fade, 1.7);
        R.beam(p.x - 7, p.y, p.x + 7, p.y, 2.6, c[0], c[1], c[2], fade, 0.6);
        R.beam(p.x, p.y - 7, p.x, p.y + 7, 2.6, c[0], c[1], c[2], fade, 0.6);
      }
    }
  }

  /**
   * Draw one enemy as a recognisable top-down craft rather than a bare polygon.
   *
   * Everything is composed from the same five SDF primitives, assembled in a
   * local frame where **+y is the direction the craft is heading** and the unit
   * is the craft's radius. That local frame is the whole trick: it means each
   * silhouette is written once as a handful of readable coordinates and works at
   * any size, any heading, without a single sprite.
   *
   * Silhouettes are deliberately distinct in outline, not just colour — at phone
   * size, on a bloom-heavy background, shape is what the eye actually resolves.
   */
  /**
   * Draw one craft from its data recipe.
   *
   * Parts live in a local frame where +y is the heading and one unit is the
   * craft's radius, so a silhouette works at any size and angle with no
   * sprites. Structure draws DIM and only the accent parts glow: parts blend
   * additively, so a craft of eight full-brightness pieces sums to white at the
   * fuselage and every archetype ends up looking the same. Hull colour also
   * darkens with damage, which is how condition stays legible from the paint
   * rather than from a bar floating overhead.
   *
   * The recipe is deliberately data rather than draw calls — js/game/craft.js
   * explains why, but briefly: the same part list also becomes the wreckage.
   */
  renderCraft(e, r, g, b, alpha) {
    const R = this.renderer;
    const s = e.radius;
    const f = e.face || 0;
    const cos = Math.cos(f), sin = Math.sin(f);
    const wx = (lx, ly) => e.x + lx * s * cos - ly * s * sin;
    const wy = (lx, ly) => e.y + lx * s * sin + ly * s * cos;

    const acc = e.accent || [r, g, b];
    const hp = Math.max(0, Math.min(1, e.hp / (e.maxHp || 1)));
    const wear = 0.45 + 0.55 * hp;
    const hr = r * wear, hg = g * wear, hb = b * wear;

    for (const part of craftParts(e.type)) {
      const m = part.m;
      switch (part.t) {
        case 'bar':
          R.beamLit(wx(part.a[0], part.a[1]), wy(part.a[0], part.a[1]),
            wx(part.b[0], part.b[1]), wy(part.b[0], part.b[1]), part.w * s,
            hr * m, hg * m, hb * m, alpha, 0.9);
          break;
        case 'gon':
          R.polyLit(wx(part.p[0], part.p[1]), wy(part.p[0], part.p[1]),
            part.r * s, part.sides, f + part.rot, hr * m, hg * m, hb * m, alpha, 0.9);
          break;
        case 'slab':
          R.slabLit(wx(part.p[0], part.p[1]), wy(part.p[0], part.p[1]),
            part.hw * s, part.hh * s, f, hr * m, hg * m, hb * m, alpha, part.shade);
          break;
        case 'dot':
          R.disc(wx(part.p[0], part.p[1]), wy(part.p[0], part.p[1]), part.r * s,
            acc[0] * m * 0.5, acc[1] * m * 0.5, acc[2] * m * 0.5, alpha);
          break;
        case 'ring': {
          // `hullFlat` is the undarkened hull colour — a couple of rings were
          // authored against it rather than the damage-worn tint.
          const c = part.tint === 'accent' ? acc
            : part.tint === 'hull' ? [hr, hg, hb] : [r, g, b];
          R.ring(e.x, e.y, part.r * s, part.w * s,
            c[0] * m, c[1] * m, c[2] * m, alpha * part.alpha);
          break;
        }
        case 'orbit':
          for (let i = 0; i < part.n; i++) {
            const a2 = e.t * part.speed + (i / part.n) * TAU;
            R.disc(e.x + Math.cos(a2) * s * part.r, e.y + Math.sin(a2) * s * part.r,
              s * part.size, acc[0], acc[1], acc[2], alpha);
          }
          break;
        default:
          break;
      }
    }

    // Running light — the one deliberately hot part of an otherwise matte hull.
    R.glow(wx(0, 0.3), wy(0, 0.3), s * 0.5, acc[0], acc[1], acc[2], 0.34 * alpha, 1.9);

    // Engine wash trailing behind — only for things that actually fly.
    if (!e.ground) {
      R.glow(wx(0, -1.05), wy(0, -1.05), s * 0.8, acc[0], acc[1], acc[2], 0.28 * alpha, 1.9);
    }
  }

  renderEnemies(time) {
    const R = this.renderer;

    // The warden's field, drawn first so craft sit inside it. Its edge is the
    // information: everything within is taking well under half damage.
    for (const w of this.enemies.items) {
      if (!w.active || !w.aura) continue;
      const c = w.accent || [0.35, 1.5, 1.25];
      const pulse = 1 + Math.sin(time * 2.2) * 0.02;
      R.ring(w.x, w.y, w.aura * pulse, 1.6, c[0], c[1], c[2], 0.32);
      R.glow(w.x, w.y, w.aura * 0.9, c[0], c[1], c[2], 0.05, 2.6);
    }

    for (const e of this.enemies.items) {
      if (!e.active) continue;
      let [r, g, b] = e.boss && e.bossDef ? e.bossDef.accent : e.color;
      let alpha = 1;

      if (e.phase) alpha = Math.sin(e.phaseT) > 0.55 ? 0.22 : 0.85;
      if (e.hitFlash > 0) {
        // Additive, not a wash: enough to register a hit, not so much that a
        // constantly-shot enemy is permanently white. Intensity scales with the
        // share of hull the hit took, so a chip and a hammer blow look different.
        const f = e.hitFlash / (e.hitFlashMax || 0.12);
        r += (0.6 + 1.2 * e.hitPower) * f;
        g += (0.6 + 1.2 * e.hitPower) * f;
        b += (0.6 + 1.2 * e.hitPower) * f;
      }
      if (this.enrage > 0) {
        const k = Math.min(1.4, this.enrage * 0.7);
        r += k; g -= k * 0.25; b -= k * 0.25;
      }

      const hpFrac = Math.max(0, e.hp / e.maxHp);

      // Shift into recoil space for the draw, then put it straight back. Every
      // other system — collision, targeting, spawning — sees the true position.
      const trueX = e.x, trueY = e.y;
      e.x += e.kx; e.y += e.ky;

      R.glow(e.x, e.y, e.radius * 2.2, r, g, b, 0.09 * alpha, 2.3);
      this.renderCraft(e, r, g, b, alpha);

      // Battle damage instead of a floating bar: scorching, then fire.
      if (hpFrac < 0.55 && !e.boss) {
        const burn = 1 - hpFrac / 0.55;
        R.glow(e.x - e.radius * 0.3, e.y - e.radius * 0.2, e.radius * 0.7,
          0.06, 0.05, 0.05, 0.5 * burn * alpha, 2.0);
        if (hpFrac < 0.28) {
          const fl = 0.6 + 0.4 * Math.sin(time * 30 + e.spin2);
          R.glow(e.x + e.radius * 0.25, e.y, e.radius * 0.55,
            1.6, 0.55, 0.12, 0.75 * fl * alpha, 1.7);
        }
      }

      if (e.warded) {
        // A sheltered craft wears the warden's colour, so "why is this not
        // dying" has a visible answer.
        R.ring(e.x, e.y, e.radius * 1.28, 1.2, 0.35, 1.5, 1.25, 0.55 * alpha);
      }
      if (e.elite) {
        // Gold chevron ring: at a glance, "this one shoots and it hurts".
        const p = 1 + Math.sin(time * 3 + e.spin2) * 0.05;
        R.ring(e.x, e.y, e.radius * 1.34 * p, 1.4, 1.5, 1.05, 0.28, 0.5 * alpha);
        R.glow(e.x, e.y, e.radius * 2.2, 1.4, 1.0, 0.3, 0.10 * alpha, 2.1);
      }
      if (e.stun > 0) {
        R.ring(e.x, e.y, e.radius + 7 + Math.sin(time * 20) * 2, 1.6, 0.5, 0.9, 1.9, 0.8);
      }
      if (e.shield > 0) {
        const f = e.shield / e.maxShield;
        R.ring(e.x, e.y, e.radius * 1.5, 1.4, 0.4, 0.8, 1.6, 0.4 + f * 0.4);
      }
      if (e.boss) {
        R.ring(e.x, e.y, e.radius * 1.7 + Math.sin(time * 4) * 2, 2.2, 1.6, 0.25, 0.35, 0.85);
        R.ring(e.x, e.y, e.radius * 2.0, 3.0, 1.5, 0.4, 0.2, 0.25);
        R.ring(e.x, e.y, e.radius * 2.0, 3.0 * hpFrac, 1.6, 0.5, 0.2, 0.9);
      }
      e.x = trueX; e.y = trueY;
    }
  }

  /** Player weapon systems: beam, chain lightning. */
  renderSystems(time) {
    const R = this.renderer;
    const s = this.stats;

    if (s.laserDps > 0) {
      // A column, running to the last thing it is cutting — or off the top of
      // the lane when it is cutting nothing.
      const last = this.laserChain.length
        ? this.laserChain[this.laserChain.length - 1] : null;
      const topY = last ? last.y : this.y0 - 20;
      const wob = Math.sin(time * 40) * 1.1;
      const wide = 3.4 + s.laserTier * 1.6;
      const lit = last ? 1 : 0.45;
      const x = this.ship.x;
      R.beam(x, this.ship.y - 12, x, topY, wide + wob * 0.5, 0.35, 1.25, 1.7, 0.42 * lit, 0.85);
      R.beam(x, this.ship.y - 12, x, topY, 1.3 + s.laserTier * 0.5, 1.5, 1.85, 2.0, 0.9 * lit, 0.5);
      for (const hit of this.laserChain) {
        R.glow(hit.x, hit.y, 18, 0.5, 1.4, 1.8, 0.5, 1.7);
      }
      if (last) {
        R.glow(last.x, last.y, 26 + wob * 2, 0.5, 1.4, 1.8, 0.6, 1.6);
        R.ring(last.x, last.y, last.radius + 6 + Math.sin(time * 18) * 2, 1.5,
          0.6, 1.5, 1.9, 0.7);
      }
      R.glow(x, this.ship.y - 14, 16, 0.5, 1.4, 1.8, 0.55 * lit, 1.7);
    }

    for (const sh of this.shells) {
      const k = Math.min(1, sh.t / sh.dur);
      R.glow(sh.x, sh.y, 13, 1.6, 1.15, 0.35, 0.85, 1.6);
      R.disc(sh.x, sh.y, 3.6, 1.7, 1.35, 0.5, 1);
      // Ghost ring at the aim point shows where it is about to go off.
      R.ring(sh.tx, sh.ty, sh.radius * (0.5 + k * 0.5), 1.3,
        1.5, 1.05, 0.3, 0.14 + k * 0.3);
    }

    for (const a of this.arcs) {
      const k = a.t / a.max;
      for (let i = 1; i < a.points.length; i++) {
        const p0 = a.points[i - 1], p1 = a.points[i];
        // Jagged: split each hop and kick the midpoint sideways.
        const mx = (p0.x + p1.x) / 2 + (Math.random() - 0.5) * 26;
        const my = (p0.y + p1.y) / 2 + (Math.random() - 0.5) * 26;
        R.beam(p0.x, p0.y, mx, my, 3.2 * k, 0.6, 0.95, 1.9, k, 0.7);
        R.beam(mx, my, p1.x, p1.y, 3.2 * k, 0.6, 0.95, 1.9, k, 0.7);
        R.beam(p0.x, p0.y, mx, my, 1.2, 1.7, 1.9, 2.0, k, 0.5);
        R.beam(mx, my, p1.x, p1.y, 1.2, 1.7, 1.9, 2.0, k, 0.5);
        R.glow(p1.x, p1.y, 18, 0.6, 1.0, 1.9, 0.55 * k, 1.7);
      }
    }
  }

  renderBeams(time) {
    const R = this.renderer;
    const w = WEAPONS.beam;
    for (const bm of this.beams) {
      const bottom = this.y1 + 40;
      if (bm.t < w.telegraph) {
        // Warning sight-line — thin, flickering, clearly not yet lethal.
        // Ramps in brightness and width as the shot charges, so "get out of
        // this column" is readable at a glance rather than a hairline.
        const k = bm.t / w.telegraph;
        const flick = 0.5 + 0.5 * Math.abs(Math.sin(time * 24));
        R.beam(bm.x, bm.y, bm.x, bottom, 2 + k * 5, 1.6, 0.45, 0.25, flick * k * 0.55, 0.95);
        R.beam(bm.x, bm.y, bm.x, bottom, 1.2, 1.8, 0.9, 0.6, flick * k, 0.6);
        R.glow(bm.x, bm.y, 26 + k * 20, 1.6, 0.5, 0.3, 0.35 * k, 1.8);
      } else {
        const k = 1 - (bm.t - w.telegraph) / w.duration;
        const width = bm.w * (0.6 + 0.4 * k);
        R.beam(bm.x, bm.y, bm.x, bottom, width, 1.6, 0.3, 0.35, 0.85 * k, 0.75);
        R.beam(bm.x, bm.y, bm.x, bottom, width * 0.35, 1.9, 1.5, 1.6, k, 0.5);
        R.glow(bm.x, bm.y, width * 2.2, 1.6, 0.4, 0.4, 0.5 * k, 1.6);
      }
    }
  }

  renderBullets() {
    const R = this.renderer;
    for (const b of this.bullets.items) {
      if (!b.active) continue;
      // Homing ordnance gets its own colour so a missile reads differently from
      // a plain shot the instant it appears.
      const c = b.fromEnemy
        ? (b.homing > 0 ? [1.7, 0.35, 0.85] : [1.5, 0.5, 0.25])
        : b.system ? COLORS[b.system]
        : b.crit ? [1.6, 1.3, 0.5] : COLORS.bullet;
      if (b.missile) {
        const ang = Math.atan2(b.vy, b.vx);
        R.spark(b.x, b.y, 11, 4, ang, c[0], c[1], c[2], 0.95);
        R.glow(b.x, b.y, 17, c[0], c[1], c[2], 0.7, 1.7);
        R.glow(b.x - Math.cos(ang) * 11, b.y - Math.sin(ang) * 11, 9,
          1.7, 1.3, 0.5, 0.75, 1.5);
        continue;
      }
      const tail = 0.026;
      R.beam(b.x - b.vx * tail, b.y - b.vy * tail, b.x, b.y, b.radius * 1.5,
        c[0], c[1], c[2], 0.85, 0.9);
      R.glow(b.x, b.y, b.radius * 4.2, c[0], c[1], c[2], 0.6, 1.8);
    }
  }

  renderParticles() {
    const R = this.renderer;
    for (const p of this.particles.items) {
      if (!p.active) continue;
      const t = p.life / p.maxLife;
      if (p.kind === 3) {
        const rr = p.size * (1 - t) + 8;
        R.ring(p.x, p.y, rr, 3 * t + 1, p.r, p.g, p.b, t * 0.8);
      } else if (p.kind === 2) {
        R.glow(p.x, p.y, p.size * (1.6 - t * 0.6), p.r, p.g, p.b, t * 0.85, 1.5);
      } else {
        const sp = Math.hypot(p.vx, p.vy);
        if (sp > 140) {
          const len = Math.min(18, sp * 0.03);
          R.spark(p.x, p.y, len, p.size * t * 0.55, p.rot, p.r, p.g, p.b, t * 0.9);
        } else {
          R.glow(p.x, p.y, p.size * t * 2.2, p.r, p.g, p.b, t * 0.8, 1.5);
        }
      }
    }
  }

  renderAbilityFX(time) {
    const R = this.renderer;
    if (this.singularity && this.singularity.t > 0) {
      const s = this.singularity;
      const pulse = 1 + Math.sin(time * 9) * 0.12;
      R.glow(s.x, s.y, 150 * pulse, 0.55, 0.25, 1.2, 0.55, 1.4);
      R.disc(s.x, s.y, 22 * pulse, 0.05, 0.02, 0.12, 1);
      for (let i = 0; i < 4; i++) {
        R.ring(s.x, s.y, 34 + i * 22 + Math.sin(time * 5 - i) * 6, 1.6, 0.7, 0.4, 1.5, 0.5 - i * 0.09);
      }
    }
    if (this.lance && this.lance.t > 0) {
      const x = this.ship.x;
      R.beam(x, this.y0 - 30, x, this.ship.y - 20, 15, 1.6, 0.35, 0.6, 0.9, 0.85);
      R.beam(x, this.y0 - 30, x, this.ship.y - 20, 5, 1.8, 1.4, 1.6, 1, 0.6);
    }
    if (this.buffs.aegis > 0) {
      const p = 1 + Math.sin(time * 7) * 0.06;
      R.ring(this.ship.x, this.ship.y, 60 * p, 3.2, 0.35, 1.5, 0.85, 0.75);
      R.glow(this.ship.x, this.ship.y, 90, 0.25, 1.1, 0.6, 0.28, 2);
    }

    // Where the player is asking the ship to go.
    const m = this.manual;
    if (m.blend > 0.02) {
      const a = m.blend;
      const pulse = 1 + Math.sin(time * 8) * 0.1;
      R.ring(m.x, m.y, 17 * pulse, 1.6, 0.4, 1.3, 1.6, 0.75 * a);
      R.ring(m.x, m.y, 7, 1.4, 0.5, 1.5, 1.7, 0.6 * a);
      for (let i = 0; i < 4; i++) {
        const ang = time * 1.6 + (i / 4) * TAU;
        R.spark(m.x + Math.cos(ang) * 24, m.y + Math.sin(ang) * 24, 5, 2, ang,
          0.4, 1.3, 1.6, 0.55 * a);
      }
      R.glow(m.x, m.y, 34, 0.35, 1.1, 1.5, 0.22 * a, 1.8);
    }
  }

  renderShip(time, run, s) {
    const R = this.renderer;
    const ship = this.ship;
    const x = ship.x, y = ship.y;
    const hullFrac = Math.max(0, run.hull / s.maxHull);
    const shieldFrac = s.maxShield > 0 ? run.shield / s.maxShield : 0;
    const over = this.buffs.overdrive > 0;
    const c = over ? [1.5, 0.9, 0.25] : COLORS.ship;
    const bank = ship.bank;

    if ((run.spawnGuard || 0) > 0) {
      const k = Math.min(1, run.spawnGuard / 2.5);
      const p2 = 1 + Math.sin(time * 12) * 0.08;
      R.ring(x, y, 34 * p2, 2.4, 1.2, 1.5, 1.9, 0.45 + k * 0.35);
      R.glow(x, y, 52, 0.9, 1.3, 1.8, 0.22 * k, 2.1);
    }
    if (shieldFrac > 0.01) {
      R.ring(x, y, 30 + Math.sin(time * 2.4) * 1.4, 2.0,
        COLORS.shield[0], COLORS.shield[1], COLORS.shield[2], 0.25 + shieldFrac * 0.45);
      R.glow(x, y, 44, COLORS.shield[0], COLORS.shield[1], COLORS.shield[2], shieldFrac * 0.18, 2.4);
    }

    // Engine plume, brighter under thrust.
    const plume = ship.thrust;
    R.glow(x - bank * 6, y + 20, 20 * plume, c[0], c[1], c[2], 0.55, 1.6);
    R.spark(x - bank * 6, y + 24, 5, 16 * plume, Math.PI / 2, c[0], c[1], c[2], 0.75);

    // Wings, swept back and rolling with the bank.
    R.beam(x - 20, y + 8, x - 4, y - 6, 4.2, c[0], c[1], c[2], 0.95, 0.55);
    R.beam(x + 20, y + 8, x + 4, y - 6, 4.2, c[0], c[1], c[2], 0.95, 0.55);

    // Hull. Brightness tracks integrity so a hurt ship visibly dims.
    const lit = 0.45 + hullFrac * 0.55;
    R.glow(x, y, 40, c[0], c[1], c[2], 0.4 * lit, 1.7);
    R.poly(x, y, 15, 3, -Math.PI / 2 + bank * 0.28, c[0] * lit, c[1] * lit, c[2] * lit, 1);
    R.disc(x, y + 2, 5.5, 1.7, 1.9, 2.0, 1);

    const wc = COLORS.wing;
    for (let i = 0; i < s.drones; i++) {
      const [wx, wy] = this.wingmanPos(i, s.drones);
      R.glow(wx, wy, 14, wc[0], wc[1], wc[2], 0.4, 1.8);
      R.poly(wx, wy, 6.5, 3, -Math.PI / 2 + bank * 0.25, wc[0] * 0.75, wc[1] * 0.75, wc[2] * 0.75, 1);
      R.glow(wx, wy + 7, 5, wc[0], wc[1], wc[2], 0.5, 1.6);
    }
  }

  /** Floating text lives on a 2D overlay canvas — WebGL has no text. */
  renderOverlay(ctx, dpr) {
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    this.renderShipStatus(ctx);
    for (const f of this.floaters) {
      const t = f.life / f.maxLife;
      const size = 13 * f.scale;
      ctx.globalAlpha = Math.min(1, t * 1.6);
      ctx.font = `700 ${size}px ui-monospace, "SF Mono", Menlo, monospace`;
      const col = `rgb(${Math.min(255, f.color[0] * 200)},${Math.min(255, f.color[1] * 200)},${Math.min(255, f.color[2] * 200)})`;
      ctx.shadowColor = col;
      ctx.shadowBlur = 8;
      ctx.fillStyle = col;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.restore();
  }
}

/**
 * Condition readout pinned to the ship, shown only when something is missing.
 *
 * Permanent bars across the top of the screen are dead pixels for most of a
 * run — they read 100% almost always, and when they do matter your eyes are on
 * the ship, not the chrome. Showing damage where the damage is happening means
 * zero UI in the good case and instant legibility in the bad one.
 */
Game.prototype.renderShipStatus = function (ctx) {
  const { run } = this.state;
  const s = this.stats;
  const hull = Math.max(0, Math.min(1, run.hull / s.maxHull));
  const shield = s.maxShield > 0 ? Math.max(0, Math.min(1, run.shield / s.maxShield)) : 1;
  if (hull > 0.995 && shield > 0.995) return;

  // Below the ship, and on a dark plate. Above the hull it sat in the busiest
  // part of the screen — incoming fire, explosions and the enemy formation all
  // occupy that space — and thin glowing text simply disappeared into it.
  const x = this.ship.x;
  const rows = [];
  if (hull <= 0.995) {
    rows.push({
      text: Math.round(hull * 100) + '%',
      col: hull > 0.6 ? '#7bf0ab' : hull > 0.3 ? '#ffc85a' : '#ff5a6e',
      size: hull < 0.3 ? 14 : 12.5,
    });
  }
  if (shield <= 0.995 && s.maxShield > 0) {
    rows.push({ text: '\u25c7 ' + Math.round(shield * 100) + '%', col: '#7cc4ff', size: 10.5 });
  }

  const lineH = 14;
  const height = rows.length * lineH + 6;
  let top = this.ship.y + this.ship.radius + 9;
  // Keep it inside the flight lane rather than under the ability row.
  top = Math.min(top, this.y1 - height - 4);

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  let width = 0;
  for (const r of rows) {
    ctx.font = `700 ${r.size}px ui-monospace, "SF Mono", Menlo, monospace`;
    width = Math.max(width, ctx.measureText(r.text).width);
  }
  width += 16;

  // Plate: cheap contrast that works over water, land or an explosion.
  ctx.globalAlpha = 0.62;
  ctx.fillStyle = '#04070e';
  const rx = x - width / 2, ry = top - 3, rr = 5;
  ctx.beginPath();
  ctx.moveTo(rx + rr, ry);
  ctx.arcTo(rx + width, ry, rx + width, ry + height, rr);
  ctx.arcTo(rx + width, ry + height, rx, ry + height, rr);
  ctx.arcTo(rx, ry + height, rx, ry, rr);
  ctx.arcTo(rx, ry, rx + width, ry, rr);
  ctx.fill();
  ctx.globalAlpha = 1;

  let y = top;
  for (const r of rows) {
    ctx.font = `700 ${r.size}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.fillStyle = r.col;
    ctx.shadowColor = r.col;
    ctx.shadowBlur = 6;
    ctx.fillText(r.text, x, y);
    ctx.shadowBlur = 0;
    y += lineH;
  }
  ctx.restore();
};

function fmtShort(n) {
  if (n < 1000) return String(Math.round(n));
  const units = ['K', 'M', 'B', 'T', 'aa', 'ab', 'ac', 'ad', 'ae', 'af'];
  const tier = Math.floor(Math.log10(n) / 3);
  if (tier > units.length) return n.toExponential(1);
  const v = n / Math.pow(1000, tier);
  return (v < 10 ? v.toFixed(1) : Math.round(v)) + units[tier - 1];
}

export { COLORS };
