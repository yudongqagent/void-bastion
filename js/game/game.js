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
} from './balance.js';
import { sectorForWave, sectorNumber, isSectorStart } from './sectors.js';

const TAU = Math.PI * 2;

// How far an enemy travels from entry to the ship in the reference layout that
// tools/simulate.mjs balances against. Real screens differ, so enemy speeds are
// rescaled to keep time-to-contact — the thing that actually decides whether a
// wave hurts you — the same everywhere.
const REFERENCE_APPROACH = 430;

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

// How far off straight-up the guns may swing. Wide enough to cover the lane,
// narrow enough that the ship never looks like it is shooting sideways.
const AIM_CONE = 0.62;

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
  weapon: null, wcd: 0, elite: false, burst: 0, burstT: 0, spin2: 0,
});

const newBullet = () => ({
  active: false, x: 0, y: 0, vx: 0, vy: 0, dmg: 0, pierce: 1, life: 0,
  crit: false, radius: 3, hits: null, fromEnemy: false,
  homing: 0, drag: 0, minSpeed: 0, missile: false,
});

const newParticle = () => ({
  active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 3,
  r: 1, g: 1, b: 1, drag: 0.94, kind: 0, rot: 0,
});

const newPickup = () => ({
  active: false, x: 0, y: 0, vx: 0, vy: 0, kind: 'coin', value: 0,
  life: 0, spin: 0, angle: 0, drawn: false,
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

    this.scroll = 0;
    this.scrollSpeed = 150;
    this.layers = [];
    this.nebulae = [];

    this.shakeAmount = 0;
    this.flashAmount = 0;
    this.flashColor = [0, 0, 0];
    this.timeScale = 1;
    this.paused = false;

    this.buffs = {};
    this.singularity = null;
    this.lance = null;
    this.storm = null;
    this.stormTimer = 5;
    this.beams = [];
    this.arcs = [];
    this.sysT = { missile: 1.2, flak: 2.0, arc: 0.9 };
    this.laserTick = 0;

    this.sector = sectorForWave(1, BOSS_INTERVAL);
    this._statsDirty = true;
    this._stats = null;

    this.applyLayout();
    this.buildBackdrop();
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
    const density = (this.fieldW * this.fieldH) / 9000;
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
    for (let i = 0; i < 4; i++) {
      this.nebulae.push({
        x: this.x0 + Math.random() * this.fieldW,
        y: this.y0 + Math.random() * this.fieldH,
        r: Math.min(this.fieldW, this.fieldH) * (0.4 + Math.random() * 0.5),
        a: 0.035 + Math.random() * 0.04,
        depth: 0.14 + Math.random() * 0.12,
      });
    }
  }

  updateBackdrop(dt) {
    const sec = this.sector;
    const base = this.scrollSpeed * (sec.scrollMult || 1);
    this.scroll += base * dt;

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
  }

  // --- zones ----------------------------------------------------------------

  enterSector(wave) {
    const next = sectorForWave(wave, BOSS_INTERVAL);
    const changed = next.id !== this.sector.id;
    this.sector = next;
    this.storm = null;
    this.stormTimer = 3 + Math.random() * 4;
    if (changed || wave <= 1) {
      this.emit('sector', { sector: next, index: sectorNumber(wave, BOSS_INTERVAL) + 1 });
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
    // Self-healing rather than only on a block boundary: a run resumed from a
    // save starts mid-block, and keying purely off isSectorStart left it flying
    // through the Asteroid Belt with Outer Reach's palette and no debris.
    if (this.sector.id !== sectorForWave(wave, BOSS_INTERVAL).id ||
        isSectorStart(wave, BOSS_INTERVAL)) {
      this.enterSector(wave);
    }
    const sec = this.sector;

    const table = spawnTable(wave);
    const total = table.reduce((a, t) => a + t.weight, 0);
    const count = Math.round(enemyCount(wave) * SWARM_DENSITY);
    const baseHP = enemyHP(wave) / SWARM_DENSITY;
    const baseDmg = enemyDamage(wave) / SWARM_DENSITY;
    const baseSpd = enemySpeed(wave);
    const baseCoin = coinValue(wave) / SWARM_DENSITY;

    const eliteRate = eliteChance(wave);
    this.spawnQueue.length = 0;
    for (let i = 0; i < count; i++) {
      let r = Math.random() * total, pick = table[0];
      for (const t of table) { r -= t.weight; if (r <= 0) { pick = t; break; } }
      const a = pick.arch;
      const elite = Math.random() < eliteRate;
      const E = elite ? ELITE : null;
      this.spawnQueue.push({
        type: pick.key,
        elite,
        hp: baseHP * a.hp * (sec.hpMult || 1) * (E ? E.hp : 1),
        speed: baseSpd * a.speed * (sec.speedMult || 1) * (E ? E.speed : 1),
        dmg: baseDmg * a.dmg * (E ? E.dmg : 1),
        coin: baseCoin * a.coin * (sec.coinMult || 1) * (E ? E.coin : 1),
        radius: a.radius * (E ? E.radius : 1), sides: a.sides,
        shield: a.shield ? baseHP * a.shield * 0.5 * (E ? E.hp : 1) : 0,
        phase: !!a.phase,
        // An elite always brings a gun, even if its archetype rams for a living.
        weapon: elite ? eliteWeapon(wave, a.weapon) : a.weapon,
        splits: pick.key === 'splitter' ? 2 : 0,
      });
    }
    if (isBossWave(wave)) {
      const b = bossStats(wave);
      this.spawnQueue.push({
        type: 'boss', hp: b.hp * (sec.hpMult || 1), speed: b.speed * (sec.speedMult || 1),
        dmg: b.damage, coin: b.coins * (sec.coinMult || 1),
        radius: b.radius, sides: 8, shield: 0, boss: true, splits: 0,
      });
      this.synth.boss();
      this.emit('boss', { wave });
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
    e.elite = !!def.elite;
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
    if (def.boss) {
      e.behavior = 'boss';
      e.holdY = this.y0 + this.fieldH * 0.22;
    } else if (def.weapon && ARTILLERY.has(def.type)) {
      // Artillery holds station and shoots; it is not trying to reach you.
      e.behavior = 'hover';
      e.holdY = this.y0 + this.fieldH * (0.16 + Math.random() * 0.42);
    } else if (def.type === 'darter' || def.type === 'wraith') {
      e.behavior = 'swarm';
    } else if (def.type === 'splitter' || def.type === 'shielder') {
      e.behavior = 'weave';
    } else {
      e.behavior = 'dive';
    }

    if (def.boss) { this.shake(14); this.flash([0.35, 0.05, 0.1], 0.5); }
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

    // 4 — line up the shot. Weak on purpose: it should lose to anything about
    // to hit us, so the ship breaks off an attack run to dodge and drifts back.
    if (this.target) {
      const tdx = this.target.x - ship.x;
      ax += Math.max(-1, Math.min(1, tdx / 90)) * 780;
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
  acquireTarget() {
    const ship = this.ship;
    const reach = this.stats.range * 1.8;
    let best = null, bestScore = Infinity;
    for (const e of this.enemies.items) {
      if (!e.active) continue;
      if (e.y > ship.y + 24) continue;                 // already behind us
      if (e.phase && Math.sin(e.phaseT) > 0.55) continue;
      const dx = e.x - ship.x, dy = e.y - ship.y;
      const d = Math.hypot(dx, dy);
      if (d > reach) continue;
      const score = d + Math.abs(dx) * 0.9;            // prefer dead ahead
      if (score < bestScore) { bestScore = score; best = e; }
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
    const spread = 0.13;
    for (let i = 0; i < s.shots; i++) {
      const off = s.shots > 1 ? (i - (s.shots - 1) / 2) * spread : 0;
      const ang = aim + off + ship.bank * 0.1;
      const crit = Math.random() < s.critChance;
      const b = this.bullets.obtain();
      b.active = true;
      b.x = ship.x + Math.cos(ang) * 18;
      b.y = ship.y + Math.sin(ang) * 18;
      const speed = 760;
      b.vx = Math.cos(ang) * speed;
      b.vy = Math.sin(ang) * speed;
      b.dmg = s.damage * (crit ? s.critMult : 1);
      b.crit = crit;
      b.pierce = s.pierce;
      b.life = 2.2;
      b.radius = crit ? 5 : 3.2;
      b.fromEnemy = false;
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

  damageEnemy(e, amount, crit, showNumber = true) {
    if (e.shield > 0) {
      const absorbed = Math.min(e.shield, amount);
      e.shield -= absorbed;
      amount -= absorbed;
      if (absorbed > 0) this.synth.shieldHit();
    }
    e.hp -= amount;
    e.hitFlash = 0.12;
    if (showNumber && amount >= 1 && Math.random() < 0.12) {
      this.addFloater(e.x, e.y - e.radius, fmtShort(amount),
        crit ? [1.6, 1.2, 0.4] : [1, 1, 1], crit ? 1.1 : 0.8);
    }
    if (e.hp <= 0) this.killEnemy(e);
  }

  killEnemy(e, silent) {
    const { run, meta } = this.state;
    e.active = false;
    run.kills++;
    meta.totalKills++;

    this.spawnExplosion(e.x, e.y, e.radius, e.color, e.boss);
    this.synth.kill(e.boss);

    if (!silent) this.dropLoot(e);

    if (this.stats.lifesteal > 0) {
      run.hull = Math.min(this.stats.maxHull, run.hull + this.stats.lifesteal);
    }

    if (e.boss) {
      this.shake(26);
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
    const s = this.stats;
    let dmg = amount * (1 - s.armor);

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
      this.shake(6 + Math.min(14, (dmg / Math.max(1, s.maxHull)) * 90));
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
    this.shake(34);
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
      this.shake(20);
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

  shake(amount) { this.shakeAmount = Math.min(46, this.shakeAmount + amount); }

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
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 0.8;
      const sp = 90 + Math.random() * 150;
      this.spawnParticle(x, y - 14, Math.cos(a) * sp, Math.sin(a) * sp,
        0.14, 3 + Math.random() * 2.5, COLORS.bullet, 0.88, 1);
    }
  }

  spawnThrust(dt) {
    const ship = this.ship;
    if (Math.random() > dt * 70) return;
    this.spawnParticle(
      ship.x - ship.bank * 8 + (Math.random() - 0.5) * 6, ship.y + 15,
      -ship.vx * 0.2 + (Math.random() - 0.5) * 30,
      130 + Math.random() * 90,
      0.28, 3.5 + Math.random() * 2.5, COLORS.ship, 0.9, 1);
  }

  spawnExplosion(x, y, radius, color, big) {
    const n = big ? 46 : Math.min(18, 7 + Math.floor(radius * 0.55));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const sp = (big ? 120 : 55) + Math.random() * (big ? 340 : 180);
      this.spawnParticle(x, y, Math.cos(a) * sp, Math.sin(a) * sp,
        0.3 + Math.random() * (big ? 0.7 : 0.35),
        (big ? 5 : 2.5) + Math.random() * (big ? 9 : 4), color, 0.9, 1);
    }
    this.spawnParticle(x, y, 0, 0, big ? 0.35 : 0.16, radius * (big ? 3.4 : 1.9), color, 1, 2);
  }

  spawnRing(x, y, radius, color, life = 0.45) {
    this.spawnParticle(x, y, 0, 0, life, radius, color, 1, 3);
  }

  // --- update -----------------------------------------------------------------

  update(dtRaw) {
    if (this.paused || this.state.run.over) { this.decayFeedback(dtRaw); return; }
    const dt = Math.min(0.05, dtRaw) * this.timeScale;
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
    this.updateEnemies(dt);
    this.updateWingmen(dt);
    this.updateSystems(dt);
    this.updatePickups(dt);
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
        if (Math.random() < dt * 40) {
          this.spawnParticle(b.x, b.y, -b.vx * 0.1, -b.vy * 0.1, 0.3, 3.2,
            [1.4, 0.8, 0.35], 0.9, 1);
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
          this.damageEnemy(e, b.dmg, b.crit);
          this.synth.hit();
          for (let k = 0; k < 2; k++) {
            const a = Math.random() * TAU;
            const sp = 40 + Math.random() * 90;
            this.spawnParticle(b.x, b.y, Math.cos(a) * sp, Math.sin(a) * sp,
              0.18, 2 + Math.random() * 2, e.color, 0.9, 1);
          }
          if (b.missile) {
            this.spawnExplosion(b.x, b.y, 13, [1.5, 0.85, 0.35], false);
            b.active = false;
            break;
          }
          if (--b.pierce <= 0) { b.active = false; break; }
        }
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
      e.t += dt;
      if (e.hitFlash > 0) e.hitFlash -= dt;
      if (e.phase) e.phaseT += dt * 2.6;
      if (regen > 0 && e.hp < e.maxHp) e.hp = Math.min(e.maxHp, e.hp + e.maxHp * regen * dt);

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
          if (e.y < e.holdY) e.y += speed * dt;
          else {
            e.x = this.cx + Math.sin(e.t * 0.55) * this.fieldW * 0.3;
            e.fireT -= dt;
            if (e.fireT <= 0) {
              e.fireT = 1.35;
              // Alternating fan and spiral, so a boss is a pattern to read
              // rather than one thing to stand beside.
              e.spin2 += 0.5;
              const spiral = Math.floor(e.t / 4) % 2 === 1;
              for (let k = 0; k < 7; k++) {
                const ang = spiral
                  ? e.spin2 + (k / 7) * TAU
                  : Math.PI / 2 + (k - 3) * 0.22;
                this.enemyShot(e, ang, { speed: 240, dmg: 0.30, life: 7 });
              }
            }
          }
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
      if (dx * dx + dy * dy < (ship.radius + e.radius) ** 2) {
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

    const rate = s.fireRate * SYSTEM.wingFraction * (this.buffs.overdrive > 0 ? 2.5 : 1);
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
      b.hits = b.hits || new Set();
      b.hits.clear();
    }
  }

  /** Shared firing angle: leads the current target inside the forward cone. */
  aimAngle() {
    let aim = -Math.PI / 2;
    const t = this.target;
    if (t) {
      const raw = Math.atan2(t.y - this.ship.y, t.x - this.ship.x);
      let delta = raw - aim;
      while (delta > Math.PI) delta -= TAU;
      while (delta < -Math.PI) delta += TAU;
      aim += Math.max(-AIM_CONE, Math.min(AIM_CONE, delta));
    }
    return aim;
  }

  // --- auto-firing weapon systems ------------------------------------------

  updateSystems(dt) {
    const s = this.stats;
    if (s.laserDps > 0) this.updateLaser(dt, s);
    if (s.missileDmg > 0) this.updateMissiles(dt, s);
    if (s.flakDmg > 0) this.updateFlak(dt, s);
    if (s.arcDmg > 0) this.updateArc(dt, s);

    for (let i = this.arcs.length - 1; i >= 0; i--) {
      this.arcs[i].t -= dt;
      if (this.arcs[i].t <= 0) this.arcs.splice(i, 1);
    }
  }

  /** Continuous beam welded to whatever the guns are tracking. */
  updateLaser(dt, s) {
    let t = this.target;
    if (!t || !t.active) {
      let bd = 1e9;
      for (const e of this.enemies.items) {
        if (!e.active || e.y > this.ship.y) continue;
        const d = Math.hypot(e.x - this.ship.x, e.y - this.ship.y);
        if (d < bd) { bd = d; t = e; }
      }
    }
    this.laserTarget = t || null;
    if (!t) return;
    this.damageEnemy(t, s.laserDps * dt, false, false);
    this.laserTick -= dt;
    if (this.laserTick <= 0) {
      this.laserTick = 0.45;
      // Periodic number so the beam's contribution is legible, rather than HP
      // silently draining with no feedback.
      this.addFloater(t.x, t.y - t.radius, fmtShort(s.laserDps * 0.45), [0.5, 1.4, 1.7], 0.8);
      if (Math.random() < 0.5) this.synth.hit();
    }
    for (let i = 0; i < 2; i++) {
      this.spawnParticle(t.x + (Math.random() - 0.5) * t.radius,
        t.y + (Math.random() - 0.5) * t.radius,
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
      const ang = -Math.PI / 2 + side * (0.5 + Math.random() * 0.3);
      b.vx = Math.cos(ang) * 260;
      b.vy = Math.sin(ang) * 260;
      b.dmg = s.missileDmg;
      b.crit = false;
      b.pierce = 1;
      b.life = 4.5;
      b.radius = 5;
      b.fromEnemy = false;
      b.homing = 3.2;
      b.drag = 0;
      b.missile = true;
      b.hits = b.hits || new Set();
      b.hits.clear();
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

    let hit = 0;
    for (const e of this.enemies.items) {
      if (!e.active) continue;
      if (Math.hypot(e.x - best.x, e.y - best.y) > s.flakRadius) continue;
      this.damageEnemy(e, s.flakDmg, false, false);
      hit++;
    }
    this.spawnRing(best.x, best.y, s.flakRadius, [1.5, 0.9, 0.3], 0.4);
    this.spawnExplosion(best.x, best.y, 16, [1.5, 0.9, 0.3], false);
    if (hit) this.addFloater(best.x, best.y, fmtShort(s.flakDmg), [1.5, 1.0, 0.35], 1.0);
    this.synth.kill(false);
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
    if (run.hull < s.maxHull) run.hull = Math.min(s.maxHull, run.hull + s.regen * dt);
    if (run.shield < s.maxShield) run.shield = Math.min(s.maxShield, run.shield + s.shieldRegen * dt);
  }

  decayFeedback(dt) {
    this.shakeAmount *= Math.pow(0.0016, dt);
    if (this.shakeAmount < 0.05) this.shakeAmount = 0;
    this.flashAmount *= Math.pow(0.0009, dt);
    if (this.flashAmount < 0.002) this.flashAmount = 0;
  }

  // --- render -------------------------------------------------------------------

  render(time) {
    const R = this.renderer;
    const s = this.stats;
    const { run } = this.state;
    R.begin();

    const sh = this.shakeAmount;
    R.shake[0] = sh ? (Math.random() - 0.5) * sh : 0;
    R.shake[1] = sh ? (Math.random() - 0.5) * sh : 0;
    R.flash[0] = this.flashColor[0] * this.flashAmount;
    R.flash[1] = this.flashColor[1] * this.flashAmount;
    R.flash[2] = this.flashColor[2] * this.flashAmount;

    this.renderBackdrop(time);
    this.renderDebris();
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
      R.glow(n.x, n.y, n.r, haze[0], haze[1], haze[2], n.a, 2.6);
    }
    for (const layer of this.layers) {
      for (const st of layer.stars) {
        // Near stars streak with the motion; far ones stay points. Cheap, and
        // it is most of what sells forward flight.
        if (layer.depth > 0.9) {
          R.push(5, st.x, st.y, st.r * 0.9, st.r * 5.5, 0,
            tint[0], tint[1], tint[2], st.a, 0, 0);
        } else {
          R.glow(st.x, st.y, st.r * 2.4, tint[0], tint[1], tint[2], st.a * 0.6, 2.2);
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
  renderCraft(e, r, g, b, alpha) {
    const R = this.renderer;
    const s = e.radius;
    const f = e.face || 0;
    const cos = Math.cos(f), sin = Math.sin(f);
    const wx = (lx, ly) => e.x + lx * s * cos - ly * s * sin;
    const wy = (lx, ly) => e.y + lx * s * sin + ly * s * cos;

    // Local-frame helpers.
    //
    // Structure is drawn DIM and cockpits bright. Parts blend additively, so a
    // craft made of eight overlapping full-brightness pieces sums to white at
    // the fuselage and every archetype ends up looking identical. Dimming the
    // hull and letting one hot cockpit sit on top is what makes a silhouette
    // read as a ship rather than a glowing smear.
    const HULL = 0.42;
    const bar = (x1, y1, x2, y2, w, m = 1, a = alpha) =>
      R.beam(wx(x1, y1), wy(x1, y1), wx(x2, y2), wy(x2, y2), w * s,
        r * m * HULL, g * m * HULL, b * m * HULL, a * 0.95, 0.42);
    const dot = (x, y, rad, m = 1, a = alpha) =>
      R.disc(wx(x, y), wy(x, y), rad * s, r * m, g * m, b * m, a);
    const gon = (x, y, rad, sides, rot, m = 1, a = alpha) =>
      R.poly(wx(x, y), wy(x, y), rad * s, sides, f + rot,
        r * m * HULL, g * m * HULL, b * m * HULL, a);

    switch (e.type) {
      case 'darter':      // needle interceptor — long, thin, all nose
        bar(0, -1.1, 0, 1.4, 0.24, 1.1);
        bar(-0.7, -0.5, 0, -0.1, 0.16, 0.8);
        bar(0.7, -0.5, 0, -0.1, 0.16, 0.8);
        dot(0, 0.55, 0.2, 2.2);
        break;

      case 'brute':       // heavy bomber — wide slab, twin engines
        gon(0, 0, 0.62, 6, 0, 0.85);
        bar(-1.5, -0.15, 1.5, -0.15, 0.3, 1.0);
        bar(-1.1, -0.15, -0.85, -0.85, 0.22, 0.8);
        bar(1.1, -0.15, 0.85, -0.85, 0.22, 0.8);
        bar(0, -0.7, 0, 1.0, 0.34, 1.05);
        dot(0, 0.35, 0.26, 2.0);
        dot(-0.62, -0.8, 0.16, 1.8);
        dot(0.62, -0.8, 0.16, 1.8);
        break;

      case 'splitter':    // twin-hull — visibly two things bolted together
        bar(-0.5, -0.8, -0.5, 0.9, 0.3, 1.0);
        bar(0.5, -0.8, 0.5, 0.9, 0.3, 1.0);
        bar(-0.5, 0.1, 0.5, 0.1, 0.26, 0.8);
        dot(-0.5, 0.5, 0.2, 1.9);
        dot(0.5, 0.5, 0.2, 1.9);
        break;

      case 'shielder':    // saucer — round, no wings, obviously armoured
        gon(0, 0, 0.78, 8, 0.8);
        R.ring(e.x, e.y, s * 1.02, s * 0.16, r * 0.7, g * 0.7, b * 0.7, alpha * 0.9);
        dot(0, 0.1, 0.3, 2.0);
        break;

      case 'sentinel':    // gunship — side pods and forward barrels
        bar(0, -0.9, 0, 1.0, 0.42, 1.0);
        bar(-1.0, -0.3, -1.0, 0.5, 0.26, 0.85);
        bar(1.0, -0.3, 1.0, 0.5, 0.26, 0.85);
        bar(-1.0, 0.1, 0, 0.1, 0.2, 0.7);
        bar(1.0, 0.1, 0, 0.1, 0.2, 0.7);
        bar(-1.0, 0.5, -1.0, 1.05, 0.12, 1.6);
        bar(1.0, 0.5, 1.0, 1.05, 0.12, 1.6);
        dot(0, 0.3, 0.26, 2.1);
        break;

      case 'gunship':     // rotorcraft — stub wings under a spinning disc
        bar(0, -0.8, 0, 0.95, 0.44, 1.0);
        bar(-0.85, -0.2, -0.85, 0.35, 0.24, 0.85);
        bar(0.85, -0.2, 0.85, 0.35, 0.24, 0.85);
        bar(-0.85, 0.1, 0, 0.1, 0.18, 0.7);
        bar(0.85, 0.1, 0, 0.1, 0.18, 0.7);
        R.ring(e.x, e.y, s * 1.15, s * 0.1, r * 0.5, g * 0.5, b * 0.5, alpha * 0.55);
        dot(0, 0.35, 0.24, 2.0);
        break;

      case 'radial':      // turret ring — barrels facing every direction
        gon(0, 0, 0.6, 8, 0, 0.9);
        for (let i = 0; i < 8; i++) {
          const a2 = (i / 8) * TAU;
          bar(Math.cos(a2) * 0.6, Math.sin(a2) * 0.6,
              Math.cos(a2) * 1.05, Math.sin(a2) * 1.05, 0.14, 1.0);
        }
        dot(0, 0, 0.3, 2.2);
        break;

      case 'lancer':      // focusing spine with prongs
        bar(0, -1.0, 0, 1.25, 0.3, 1.0);
        bar(-0.55, 0.35, -0.3, 1.15, 0.16, 1.2);
        bar(0.55, 0.35, 0.3, 1.15, 0.16, 1.2);
        bar(-0.75, -0.35, 0.75, -0.35, 0.22, 0.8);
        dot(0, 1.2, 0.2, 2.4);
        dot(0, -0.2, 0.24, 1.9);
        break;

      case 'dread':       // capital ship — layered slabs and sponsons
        gon(0, 0, 0.7, 6, 0, 0.8);
        bar(0, -1.0, 0, 1.1, 0.5, 0.95);
        bar(-1.25, -0.3, 1.25, -0.3, 0.32, 0.9);
        bar(-1.25, -0.3, -1.05, 0.5, 0.28, 0.85);
        bar(1.25, -0.3, 1.05, 0.5, 0.28, 0.85);
        bar(-1.05, 0.5, -1.05, 0.95, 0.15, 1.6);
        bar(1.05, 0.5, 1.05, 0.95, 0.15, 1.6);
        dot(0, -0.05, 0.3, 2.1);
        break;

      case 'wraith':      // stealth delta — one clean swept wing, no fuselage
        gon(0, 0.1, 0.95, 3, 0, 0.7);
        bar(-0.95, -0.5, 0.95, -0.5, 0.18, 1.1);
        dot(0, 0.3, 0.2, 1.9);
        break;

      case 'boss': {      // battleship — bridge, sponsons, gun batteries
        gon(0, 0, 0.72, 6, 0, 0.75);
        bar(0, -1.0, 0, 1.1, 0.55, 0.95);
        bar(-1.35, -0.35, 1.35, -0.35, 0.34, 0.9);
        bar(-1.35, -0.35, -1.15, 0.55, 0.3, 0.85);
        bar(1.35, -0.35, 1.15, 0.55, 0.3, 0.85);
        bar(-1.15, 0.55, -1.15, 1.0, 0.16, 1.7);
        bar(1.15, 0.55, 1.15, 1.0, 0.16, 1.7);
        bar(0, 0.6, 0, 1.25, 0.2, 1.8);
        dot(0, -0.1, 0.34, 2.2);
        dot(-0.55, -0.75, 0.2, 1.6);
        dot(0.55, -0.75, 0.2, 1.6);
        break;
      }

      default:            // drone — the workhorse dart
        bar(0, -0.85, 0, 1.05, 0.3, 1.05);
        bar(-1.05, -0.45, 0, 0.15, 0.22, 0.85);
        bar(1.05, -0.45, 0, 0.15, 0.22, 0.85);
        dot(0, 0.4, 0.24, 2.1);
        break;
    }

    // Engine wash trailing behind, so a craft reads as moving even when static.
    R.glow(wx(0, -1.05), wy(0, -1.05), s * 0.8, r, g, b, 0.22 * alpha, 1.9);
  }

  renderEnemies(time) {
    const R = this.renderer;
    for (const e of this.enemies.items) {
      if (!e.active) continue;
      let [r, g, b] = e.color;
      let alpha = 1;

      if (e.phase) alpha = Math.sin(e.phaseT) > 0.55 ? 0.22 : 0.85;
      if (e.hitFlash > 0) {
        // Additive, not a wash: enough to register a hit, not so much that a
        // constantly-shot enemy is permanently white.
        const f = e.hitFlash / 0.12;
        r += 0.9 * f; g += 0.9 * f; b += 0.9 * f;
      }
      if (this.enrage > 0) {
        const k = Math.min(1.4, this.enrage * 0.7);
        r += k; g -= k * 0.25; b -= k * 0.25;
      }

      const hpFrac = Math.max(0, e.hp / e.maxHp);
      R.glow(e.x, e.y, e.radius * 2.4, r, g, b, 0.13 * alpha, 2.2);
      this.renderCraft(e, r, g, b, alpha);

      if (e.elite) {
        // Gold chevron ring: at a glance, "this one shoots and it hurts".
        const p = 1 + Math.sin(time * 3 + e.spin2) * 0.05;
        R.ring(e.x, e.y, e.radius * 1.38 * p, 1.7, 1.6, 1.15, 0.3, 0.75 * alpha);
        R.glow(e.x, e.y, e.radius * 2.4, 1.5, 1.1, 0.35, 0.16 * alpha, 2.0);
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
      } else if (hpFrac < 0.999) {
        // Health pips sit ahead of the craft so they never hide under the hull.
        const w = e.radius * 1.1;
        const by = e.y + e.radius * 1.55;
        R.beam(e.x - w, by, e.x + w, by, 1.1, 0.35, 0.35, 0.42, 0.3 * alpha, 0.5);
        R.beam(e.x - w, by, e.x - w + 2 * w * hpFrac, by, 1.1,
          r * 0.75, g * 0.75, b * 0.75, 0.7 * alpha, 0.5);
      }
    }
  }

  /** Player weapon systems: beam, chain lightning. */
  renderSystems(time) {
    const R = this.renderer;
    const s = this.stats;

    if (s.laserDps > 0 && this.laserTarget && this.laserTarget.active) {
      const t = this.laserTarget;
      const wob = Math.sin(time * 40) * 1.1;
      R.beam(this.ship.x, this.ship.y - 12, t.x, t.y, 7 + wob, 0.35, 1.25, 1.7, 0.55, 0.85);
      R.beam(this.ship.x, this.ship.y - 12, t.x, t.y, 2.4, 1.6, 1.9, 2.0, 0.95, 0.5);
      R.glow(t.x, t.y, 26 + wob * 2, 0.5, 1.4, 1.8, 0.6, 1.6);
      R.glow(this.ship.x, this.ship.y - 14, 16, 0.5, 1.4, 1.8, 0.55, 1.7);
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
        : (b.missile ? [1.6, 0.95, 0.4] : b.crit ? [1.6, 1.3, 0.5] : COLORS.bullet);
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

    for (let i = 0; i < s.drones; i++) {
      const [wx, wy] = this.wingmanPos(i, s.drones);
      R.glow(wx, wy, 14, c[0], c[1], c[2], 0.42, 1.8);
      R.poly(wx, wy, 6.5, 3, -Math.PI / 2 + bank * 0.25, c[0] * 0.8, c[1] * 0.8, c[2] * 0.8, 1);
      R.glow(wx, wy + 7, 5, c[0], c[1], c[2], 0.5, 1.6);
    }
  }

  /** Floating text lives on a 2D overlay canvas — WebGL has no text. */
  renderOverlay(ctx, dpr) {
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const sx = this.renderer.shake[0], sy = this.renderer.shake[1];
    for (const f of this.floaters) {
      const t = f.life / f.maxLife;
      const size = 13 * f.scale;
      ctx.globalAlpha = Math.min(1, t * 1.6);
      ctx.font = `700 ${size}px ui-monospace, "SF Mono", Menlo, monospace`;
      const col = `rgb(${Math.min(255, f.color[0] * 200)},${Math.min(255, f.color[1] * 200)},${Math.min(255, f.color[2] * 200)})`;
      ctx.shadowColor = col;
      ctx.shadowBlur = 8;
      ctx.fillStyle = col;
      ctx.fillText(f.text, f.x + sx, f.y + sy);
    }
    ctx.restore();
  }
}

function fmtShort(n) {
  if (n < 1000) return String(Math.round(n));
  const units = ['K', 'M', 'B', 'T', 'aa', 'ab', 'ac', 'ad', 'ae', 'af'];
  const tier = Math.floor(Math.log10(n) / 3);
  if (tier > units.length) return n.toExponential(1);
  const v = n / Math.pow(1000, tier);
  return (v < 10 ? v.toFixed(1) : Math.round(v)) + units[tier - 1];
}

export { COLORS };
