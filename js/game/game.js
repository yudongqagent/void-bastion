// VOID BASTION — simulation.
//
// Owns the world: the bastion, the swarm, projectiles, particles, abilities and
// wave flow. Knows nothing about the DOM chrome around it; it emits events and
// main.js decides what the UI does with them.
//
// Every entity type is pooled. At wave 400 there can be 150 enemies, several
// hundred projectiles and a couple of thousand particles alive at once, and
// allocating those per frame would hand the GC a stutter every few seconds.
// Pools mean the steady-state allocation rate is essentially zero.

import {
  enemyHP, enemyCount, enemySpeed, enemyDamage, coinValue, waveClearBonus,
  spawnWindow, isBossWave, bossStats, spawnTable, ABILITIES, deriveStats,
} from './balance.js';

const TAU = Math.PI * 2;

// The approach length tools/simulate.mjs assumes when it balances waves.
// Enemy speeds are rescaled to this so pacing is viewport-independent.
const REFERENCE_APPROACH = 430;

// Seconds a single wave may run before the survivors start enraging.
const ENRAGE_AFTER = 100;

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
  tower:    [0.30, 1.05, 1.35],
  bullet:   [0.55, 1.30, 1.60],
  shield:   [0.35, 0.85, 1.50],
  coin:     [1.50, 1.15, 0.35],
};

function pool(factory, initial) {
  const items = [];
  for (let i = 0; i < initial; i++) items.push(factory());
  return {
    items,
    obtain() {
      for (let i = 0; i < this.items.length; i++) {
        if (!this.items[i].active) return this.items[i];
      }
      const n = factory();
      this.items.push(n);
      return n;
    },
  };
}

// A monotonically advancing cursor makes pool acquisition O(1) amortised
// instead of O(n) scanning, which matters once pools hold thousands of items.
function fastPool(factory, initial) {
  const p = pool(factory, initial);
  p.cursor = 0;
  p.obtain = function () {
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
  };
  return p;
}

const newEnemy = () => ({
  active: false, x: 0, y: 0, vx: 0, vy: 0, hp: 0, maxHp: 0, speed: 0, radius: 10,
  sides: 3, dmg: 0, coin: 0, color: COLORS.drone, type: 'drone', angle: 0, spin: 0,
  shield: 0, maxShield: 0, slowT: 0, hitFlash: 0, splits: 0, boss: false,
  ranged: false, fireT: 0, phase: false, phaseT: 0, held: 0, distScale: 1,
});

const newBullet = () => ({
  active: false, x: 0, y: 0, vx: 0, vy: 0, dmg: 0, pierce: 1, life: 0,
  crit: false, radius: 3, hits: null, fromEnemy: false, color: COLORS.bullet,
});

const newParticle = () => ({
  active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 3,
  r: 1, g: 1, b: 1, drag: 0.94, kind: 0, rot: 0,
});

export class Game {
  constructor(state, synth, renderer) {
    this.state = state;
    this.synth = synth;
    this.renderer = renderer;

    this.enemies = fastPool(newEnemy, 200);
    this.bullets = fastPool(newBullet, 400);
    this.particles = fastPool(newParticle, 1600);

    this.floaters = [];      // damage / coin text, drawn on the 2D overlay
    this.events = [];        // consumed by main.js each frame

    // Seeded with a usable field, not zeros: resize() can legitimately never
    // fire (a tab that is never laid out), and an unsized world puts the spawn
    // ring on top of the bastion — or at NaN — instead of around it.
    this.w = 800; this.h = 600;
    this.cx = 400; this.cy = 300;
    this.spawnRX = 448; this.spawnRY = 348;
    this.insetTop = 0; this.insetRight = 0; this.insetBottom = 0;

    this.spawnQueue = [];
    this.spawnTimer = 0;
    this.spawnInterval = 1;
    this.waveActive = false;
    this.interWave = 1.2;
    this.waveTime = 0;
    this.enrage = 0;
    this.fireTimer = 0;
    this.turretAngle = -Math.PI / 2;
    this.droneAngle = 0;

    this.shakeAmount = 0;
    this.flashAmount = 0;
    this.flashColor = [0, 0, 0];
    this.timeScale = 1;
    this.paused = false;

    this.buffs = {};          // ability key -> seconds remaining
    this.singularity = null;
    this.lance = null;

    this.stars = [];
    this._statsDirty = true;
    this._stats = null;

    this.recomputeStats();
  }

  emit(type, data) { this.events.push({ type, data }); }

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

  resize(w, h) {
    this.w = w; this.h = h;
    this.applyLayout();
    this.buildStars();
  }

  /**
   * Tell the world how much of the viewport the UI is covering, so the bastion
   * stays centred in what the player can actually SEE. Without this, opening
   * the upgrade sheet on a phone parks it directly on top of the tower and you
   * shop blind — the one moment you most want to watch the fight.
   */
  setInsets(top, right, bottom) {
    this.insetTop = top;
    this.insetRight = right;
    this.insetBottom = bottom;
    this.applyLayout();
  }

  applyLayout() {
    const top = this.insetTop || 0;
    const vw = Math.max(220, this.w - (this.insetRight || 0));
    const vh = Math.max(220, this.h - top - (this.insetBottom || 0));
    this.cx = vw / 2;
    this.cy = top + vh / 2;
    // Enemies enter on an ELLIPSE hugging the visible field, not a circle around
    // the diagonal. A circle big enough to clear the corners of a wide desktop
    // window sits ~900px out, and at the deliberately low speeds this game uses
    // that is a 35-second stroll before anything reaches the bastion. The
    // ellipse keeps every approach about one screen-half long on any shape of
    // screen, so pacing feels the same on a phone and on a monitor.
    this.spawnRX = vw / 2 + 48;
    this.spawnRY = vh / 2 + 48;
  }

  buildStars() {
    this.stars.length = 0;
    const n = Math.round((this.w * this.h) / 5200);
    for (let i = 0; i < n; i++) {
      this.stars.push({
        x: Math.random() * this.w,
        y: Math.random() * this.h,
        r: 0.4 + Math.random() * 1.5,
        a: 0.15 + Math.random() * 0.55,
        tw: Math.random() * TAU,
        sp: 0.4 + Math.random() * 1.4,
      });
    }
  }

  // --- wave flow -------------------------------------------------------------

  startWave() {
    const wave = this.state.run.wave;
    const table = spawnTable(wave);
    const total = table.reduce((a, t) => a + t.weight, 0);
    const count = enemyCount(wave);
    const baseHP = enemyHP(wave);
    const baseDmg = enemyDamage(wave);
    const baseSpd = enemySpeed(wave);
    const baseCoin = coinValue(wave);

    this.spawnQueue.length = 0;
    for (let i = 0; i < count; i++) {
      let r = Math.random() * total, pick = table[0];
      for (const t of table) { r -= t.weight; if (r <= 0) { pick = t; break; } }
      const a = pick.arch;
      this.spawnQueue.push({
        type: pick.key, hp: baseHP * a.hp, speed: baseSpd * a.speed,
        dmg: baseDmg * a.dmg, coin: baseCoin * a.coin, radius: a.radius,
        sides: a.sides, shield: a.shield ? baseHP * a.shield * 0.5 : 0,
        ranged: !!a.ranged, phase: !!a.phase,
        splits: pick.key === 'splitter' ? 2 : 0,
      });
    }
    if (isBossWave(wave)) {
      const b = bossStats(wave);
      this.spawnQueue.push({
        type: 'boss', hp: b.hp, speed: b.speed, dmg: b.damage, coin: b.coins,
        radius: b.radius, sides: 8, shield: 0, boss: true, splits: 0,
      });
      this.synth.boss();
      this.emit('boss', { wave });
    }

    this.spawnInterval = spawnWindow(wave) / Math.max(1, this.spawnQueue.length);
    this.spawnTimer = 0;
    this.waveActive = true;
    this.waveTime = 0;
    this.enrage = 0;
    this.synth.waveStart(wave);
    this.emit('waveStart', { wave });
  }

  completeWave() {
    const { run } = this.state;
    const bonus = waveClearBonus(run.wave) * this.stats.coinMult;
    run.coins += bonus;
    this.addFloater(this.cx, this.cy - 70, '+' + Math.floor(bonus), COLORS.coin, 1.3);
    this.waveActive = false;
    this.interWave = 1.1;

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

  spawnOne(def) {
    const e = this.enemies.obtain();
    const ang = Math.random() * TAU;
    e.active = true;
    e.x = this.cx + Math.cos(ang) * this.spawnRX;
    e.y = this.cy + Math.sin(ang) * this.spawnRY;
    // balance.js gives speeds in px/sec against a reference approach of
    // REFERENCE_APPROACH px (what tools/simulate.mjs assumes). Real approach
    // length varies with viewport and spawn angle, so scale the speed to keep
    // time-to-contact — the thing that actually decides whether a wave kills
    // you — identical everywhere. Without this, a wide monitor is far easier
    // than a phone purely because enemies walk further.
    e.distScale = Math.hypot(e.x - this.cx, e.y - this.cy) / REFERENCE_APPROACH;
    e.hp = e.maxHp = def.hp;
    e.speed = def.speed;
    e.dmg = def.dmg;
    e.coin = def.coin;
    e.radius = def.radius;
    e.sides = def.sides;
    e.shield = e.maxShield = def.shield || 0;
    e.type = def.type;
    e.boss = !!def.boss;
    e.ranged = !!def.ranged;
    e.phase = !!def.phase;
    e.splits = def.splits || 0;
    e.color = COLORS[def.type] || COLORS.drone;
    e.angle = Math.random() * TAU;
    e.spin = (Math.random() - 0.5) * 1.6;
    e.slowT = 0; e.hitFlash = 0; e.fireT = 1 + Math.random(); e.phaseT = Math.random() * TAU;
    e.held = 0;
    if (def.boss) { this.shake(14); this.flash([0.35, 0.05, 0.1], 0.5); }
    return e;
  }

  // --- combat ----------------------------------------------------------------

  fire(dt) {
    const s = this.stats;
    const rate = s.fireRate * (this.buffs.overdrive > 0 ? 2.5 : 1);
    this.fireTimer -= dt;
    if (this.fireTimer > 0) return;

    const target = this.nearestEnemy(this.cx, this.cy, s.range);
    if (!target) { this.fireTimer = 0; return; }

    this.fireTimer += 1 / Math.max(0.1, rate);

    const base = Math.atan2(target.y - this.cy, target.x - this.cx);
    this.turretAngle = base;
    const spread = s.shots > 1 ? 0.20 : 0;

    for (let i = 0; i < s.shots; i++) {
      const off = s.shots > 1 ? (i - (s.shots - 1) / 2) * spread : 0;
      const ang = base + off;
      const crit = Math.random() < s.critChance;
      const b = this.bullets.obtain();
      b.active = true;
      b.x = this.cx + Math.cos(ang) * 26;
      b.y = this.cy + Math.sin(ang) * 26;
      const speed = 620;
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
    this.spawnMuzzle(base);
    this.synth.shot(1 + (this.buffs.overdrive > 0 ? 0.25 : 0));
  }

  nearestEnemy(x, y, maxDist) {
    let best = null, bestD = maxDist * maxDist;
    const items = this.enemies.items;
    for (let i = 0; i < items.length; i++) {
      const e = items[i];
      if (!e.active) continue;
      const dx = e.x - x, dy = e.y - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
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
    if (showNumber && Math.random() < 0.35) {
      this.addFloater(e.x, e.y - e.radius, fmtShort(amount),
        crit ? [1.6, 1.2, 0.4] : [1, 1, 1], crit ? 1.15 : 0.85);
    }
    if (e.hp <= 0) this.killEnemy(e);
  }

  killEnemy(e) {
    const { run, meta } = this.state;
    e.active = false;
    run.kills++;
    meta.totalKills++;

    const gained = e.coin * this.stats.coinMult;
    run.coins += gained;
    if (this.stats.lifesteal > 0) {
      run.hull = Math.min(this.stats.maxHull, run.hull + this.stats.lifesteal);
    }

    this.spawnExplosion(e.x, e.y, e.radius, e.color, e.boss);
    this.synth.kill(e.boss);

    if (e.boss) {
      this.shake(26);
      this.flash([0.5, 0.15, 0.2], 0.8);
      this.addFloater(e.x, e.y, '+' + fmtShort(gained), COLORS.coin, 1.8);
      this.emit('bossKill', { wave: run.wave });
    } else if (e.splits > 0) {
      for (let i = 0; i < e.splits; i++) {
        const c = this.enemies.obtain();
        Object.assign(c, {
          active: true, x: e.x + (Math.random() - 0.5) * 20, y: e.y + (Math.random() - 0.5) * 20,
          hp: e.maxHp * 0.32, maxHp: e.maxHp * 0.32, speed: e.speed * 1.4,
          dmg: e.dmg * 0.5, coin: e.coin * 0.3, radius: e.radius * 0.62,
          sides: 4, shield: 0, maxShield: 0, type: 'splitter', color: COLORS.splitter,
          boss: false, ranged: false, phase: false, splits: 0,
          angle: Math.random() * TAU, spin: (Math.random() - 0.5) * 3,
          slowT: 0, hitFlash: 0, fireT: 0, phaseT: 0, held: 0, distScale: e.distScale,
        });
      }
    }
    this.state.markDirty();
  }

  damageTower(amount, source) {
    const { run } = this.state;
    if (this.buffs.aegis > 0) { this.synth.shieldHit(); return; }
    const s = this.stats;
    let dmg = amount * (1 - s.armor);

    if (run.shield > 0) {
      const absorbed = Math.min(run.shield, dmg);
      run.shield -= absorbed;
      dmg -= absorbed;
      this.synth.shieldHit();
      this.spawnRing(this.cx, this.cy, 46, COLORS.shield);
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
    this.state.run.over = true;
    this.state.run.hull = 0;
    this.synth.death();
    this.shake(34);
    this.flash([0.55, 0.1, 0.15], 1.1);
    this.emit('runOver', { wave: this.state.run.wave });
    this.state.save();
  }

  // --- abilities --------------------------------------------------------------

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
      // Scaled off current-wave HP so it stays relevant at any depth.
      const power = enemyHP(run.wave) * 5.5 + this.stats.damage * 30;
      for (const e of this.enemies.items) {
        if (!e.active) continue;
        this.damageEnemy(e, power, false, false);
      }
      this.spawnRing(this.cx, this.cy, this.w, [0.4, 0.9, 1.6], 0.9);
      this.shake(20);
      this.flash([0.2, 0.45, 0.6], 0.85);
    } else if (key === 'aegis') {
      this.buffs.aegis = def.dur;
      run.shield = this.stats.maxShield;
      run.hull = Math.min(this.stats.maxHull, run.hull + this.stats.maxHull * 0.25);
      this.spawnRing(this.cx, this.cy, 120, [0.4, 1.5, 0.9], 0.8);
    } else if (key === 'singularity') {
      this.singularity = { t: def.dur, x: this.cx, y: this.cy, r: 0 };
      this.buffs.singularity = def.dur;
    } else if (key === 'lance') {
      this.lance = { t: def.dur, angle: Math.random() * TAU };
      this.buffs.lance = def.dur;
    }
    this.state.markDirty();
    return true;
  }

  // --- particles / feedback ----------------------------------------------------

  shake(amount) { this.shakeAmount = Math.min(46, this.shakeAmount + amount); }

  flash(color, amount) {
    if (amount > this.flashAmount) {
      this.flashAmount = amount;
      this.flashColor = color;
    }
  }

  addFloater(x, y, text, color, scale = 1) {
    if (this.floaters.length > 44) this.floaters.shift();
    this.floaters.push({ x, y, text, color, scale, life: 0.95, maxLife: 0.95, vy: -42 });
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

  spawnMuzzle(angle) {
    const x = this.cx + Math.cos(angle) * 30;
    const y = this.cy + Math.sin(angle) * 30;
    for (let i = 0; i < 3; i++) {
      const a = angle + (Math.random() - 0.5) * 0.7;
      const sp = 120 + Math.random() * 180;
      this.spawnParticle(x, y, Math.cos(a) * sp, Math.sin(a) * sp,
        0.16 + Math.random() * 0.1, 3 + Math.random() * 3, COLORS.bullet, 0.88, 1);
    }
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
    // Core flash
    this.spawnParticle(x, y, 0, 0, big ? 0.35 : 0.16, radius * (big ? 3.4 : 1.9), color, 1, 2);
  }

  spawnRing(x, y, radius, color, life = 0.45) {
    const p = this.spawnParticle(x, y, 0, 0, life, radius, color, 1, 3);
    p.maxLife = life;
  }

  // --- update -----------------------------------------------------------------

  update(dtRaw) {
    if (this.paused || this.state.run.over) {
      this.decayFeedback(dtRaw);
      return;
    }
    // Clamp so a backgrounded tab does not resume with a giant catch-up step
    // that teleports enemies through the tower.
    const dt = Math.min(0.05, dtRaw) * this.timeScale;
    const { run } = this.state;
    run.elapsed += dt;

    this.updateBuffs(dt);
    this.updateWave(dt);
    this.fire(dt);
    this.updateBullets(dt);
    this.updateEnemies(dt);
    this.updateDrones(dt);
    this.updateParticles(dt);
    this.updateFloaters(dt);
    this.updateRegen(dt);
    this.decayFeedback(dtRaw);
  }

  updateBuffs(dt) {
    for (const k of Object.keys(this.buffs)) {
      if (this.buffs[k] > 0) {
        this.buffs[k] -= dt;
        if (this.buffs[k] <= 0) {
          delete this.buffs[k];
          if (k === 'singularity') this.singularity = null;
          if (k === 'lance') this.lance = null;
        }
      }
    }
    const cds = this.state.run.cooldowns;
    for (const k of Object.keys(cds)) {
      if (cds[k] > 0) cds[k] = Math.max(0, cds[k] - dt);
    }
    if (this.singularity) this.singularity.t -= dt;
    if (this.lance) { this.lance.t -= dt; this.lance.angle += dt * 2.4; }
  }

  updateWave(dt) {
    if (!this.waveActive) {
      this.interWave -= dt;
      if (this.interWave <= 0) this.startWave();
      return;
    }

    // Anti-stall. Sentinels hold at range instead of closing, so a bastion with
    // strong regen but not enough damage to finish them can sit in a wave
    // forever — neither winning nor dying. After ENRAGE_AFTER the survivors
    // wind up: faster and hitting harder, without end. The standoff always
    // resolves, one way or the other.
    this.waveTime += dt;
    if (this.waveTime > ENRAGE_AFTER) {
      const prev = this.enrage;
      this.enrage = (this.waveTime - ENRAGE_AFTER) / 30;
      if (prev === 0 && this.enrage > 0) {
        this.emit('enrage', { wave: this.state.run.wave });
        this.flash([0.4, 0.1, 0.1], 0.5);
      }
    }

    this.spawnTimer -= dt;
    while (this.spawnQueue.length && this.spawnTimer <= 0) {
      this.spawnOne(this.spawnQueue.shift());
      this.spawnTimer += this.spawnInterval;
    }
    if (!this.spawnQueue.length) {
      let anyAlive = false;
      for (const e of this.enemies.items) { if (e.active) { anyAlive = true; break; } }
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
      if (b.life <= 0 || b.x < -60 || b.y < -60 || b.x > this.w + 60 || b.y > this.h + 60) {
        b.active = false;
        continue;
      }

      if (b.fromEnemy) {
        const dx = b.x - this.cx, dy = b.y - this.cy;
        if (dx * dx + dy * dy < 30 * 30) {
          b.active = false;
          this.damageTower(b.dmg, null);
        }
        continue;
      }

      for (let j = 0; j < enemies.length; j++) {
        const e = enemies[j];
        if (!e.active || b.hits.has(e)) continue;
        // Wraiths blink out of phase and cannot be hit for part of their cycle.
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
          if (--b.pierce <= 0) { b.active = false; break; }
        }
      }
    }
  }

  updateEnemies(dt) {
    const s = this.stats;
    const items = this.enemies.items;
    const sing = this.singularity;

    for (let i = 0; i < items.length; i++) {
      const e = items[i];
      if (!e.active) continue;

      e.angle += e.spin * dt;
      if (e.hitFlash > 0) e.hitFlash -= dt;
      if (e.phase) e.phaseT += dt * 2.6;

      let dx = this.cx - e.x, dy = this.cy - e.y;
      let dist = Math.hypot(dx, dy) || 0.001;

      // Singularity overrides normal movement: everything is dragged to the
      // well and pinned there while it lasts.
      if (sing && sing.t > 0) {
        const sdx = sing.x - e.x, sdy = sing.y - e.y;
        const sd = Math.hypot(sdx, sdy) || 0.001;
        const pull = Math.min(560, 22000 / Math.max(40, sd));
        e.x += (sdx / sd) * pull * dt;
        e.y += (sdy / sd) * pull * dt;
        e.spin = 6;
        if (sd < 90) continue;
        continue;
      }

      const speed = e.speed * e.distScale * (1 - s.slowField) * (1 + this.enrage * 1.5);

      if (e.ranged) {
        // Sentinels hold at three-quarters of tower range and shoot.
        // An enraged Sentinel abandons its standoff and charges.
        const hold = this.enrage > 0 ? 0 : s.range * 0.78;
        if (dist > hold) {
          e.x += (dx / dist) * speed * dt;
          e.y += (dy / dist) * speed * dt;
        } else {
          e.fireT -= dt;
          if (e.fireT <= 0) {
            e.fireT = 2.4;
            const b = this.bullets.obtain();
            b.active = true;
            b.x = e.x; b.y = e.y;
            const sp = 240;
            b.vx = (dx / dist) * sp; b.vy = (dy / dist) * sp;
            b.dmg = e.dmg * 0.55;
            b.pierce = 1; b.life = 4; b.radius = 4; b.crit = false;
            b.fromEnemy = true;
            b.hits = b.hits || new Set();
            b.hits.clear();
          }
        }
      } else {
        e.x += (dx / dist) * speed * dt;
        e.y += (dy / dist) * speed * dt;
      }

      // Orbital lance: a rotating beam that shreds whatever it crosses.
      if (this.lance && this.lance.t > 0) {
        const ea = Math.atan2(e.y - this.cy, e.x - this.cx);
        let diff = Math.abs(((ea - this.lance.angle + Math.PI) % TAU) - Math.PI);
        if (diff < 0.16) {
          this.damageEnemy(e, (enemyHP(this.state.run.wave) * 2.2 + s.damage * 8) * dt, false, false);
          if (!e.active) continue;
        }
      }

      if (dist <= 30 + e.radius * 0.5) {
        this.damageTower(e.dmg * (1 + this.enrage * 2), e);
        if (e.active) {
          e.active = false;
          this.spawnExplosion(e.x, e.y, e.radius, e.color, false);
        }
      }
    }
  }

  updateDrones(dt) {
    const s = this.stats;
    if (s.drones <= 0) return;
    this.droneAngle += dt * 1.1;
    const orbit = 74;
    for (let i = 0; i < s.drones; i++) {
      const a = this.droneAngle + (i / s.drones) * TAU;
      const dx = this.cx + Math.cos(a) * orbit;
      const dy = this.cy + Math.sin(a) * orbit;
      const target = this.nearestEnemy(dx, dy, s.range * 0.9);
      if (!target) continue;
      // Drones apply continuous damage rather than discrete shots — cheaper,
      // and visually reads as a sustained tether.
      this.damageEnemy(target, s.damage * s.fireRate * 0.2 * dt, false, false);
      if (Math.random() < dt * 8) {
        this.spawnParticle(dx, dy, (target.x - dx) * 1.6, (target.y - dy) * 1.6,
          0.12, 2, COLORS.tower, 1, 1);
      }
    }
  }

  updateParticles(dt) {
    const items = this.particles.items;
    for (let i = 0; i < items.length; i++) {
      const p = items[i];
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

  // --- render -----------------------------------------------------------------

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

    // Starfield
    for (const st of this.stars) {
      const tw = 0.62 + 0.38 * Math.sin(time * st.sp + st.tw);
      R.glow(st.x, st.y, st.r * 2.6, 0.55, 0.72, 1.0, st.a * tw * 0.5, 2.2);
    }

    this.renderGrid(time);

    // Range indicator
    R.ring(this.cx, this.cy, s.range, 1.2, 0.16, 0.42, 0.62, 0.32);

    this.renderEnemies(time);
    this.renderBullets();
    this.renderParticles();
    this.renderAbilityFX(time);
    this.renderTower(time, run, s);

    R.flush();
  }

  renderGrid(time) {
    const R = this.renderer;
    const pulse = 0.5 + 0.5 * Math.sin(time * 0.5);
    // Concentric rings receding from the bastion give a sense of scale and make
    // enemy approach speed readable. Spacing follows the field so the grid
    // reaches the edge on a monitor without crowding a phone.
    const reach = Math.max(this.spawnRX, this.spawnRY);
    const rings = 5;
    for (let i = 1; i <= rings; i++) {
      const r = (reach / rings) * i + Math.sin(time * 0.35 + i) * 4;
      R.ring(this.cx, this.cy, r, 0.7, 0.12, 0.28, 0.5, 0.2 + pulse * 0.06);
    }
    const spokes = 12;
    for (let i = 0; i < spokes; i++) {
      const a = (i / spokes) * TAU + time * 0.03;
      const r0 = 60, r1 = reach;
      R.beam(this.cx + Math.cos(a) * r0, this.cy + Math.sin(a) * r0,
        this.cx + Math.cos(a) * r1, this.cy + Math.sin(a) * r1,
        0.7, 0.10, 0.24, 0.44, 0.16, 1);
    }
  }

  renderEnemies(time) {
    const R = this.renderer;
    const items = this.enemies.items;
    for (let i = 0; i < items.length; i++) {
      const e = items[i];
      if (!e.active) continue;
      let [r, g, b] = e.color;
      let alpha = 1;

      if (e.phase) {
        const ph = Math.sin(e.phaseT);
        alpha = ph > 0.55 ? 0.22 : 0.85;
      }
      if (e.hitFlash > 0) {
        const f = e.hitFlash / 0.12;
        r += 1.8 * f; g += 1.8 * f; b += 1.8 * f;
      }
      if (this.enrage > 0) {
        const k = Math.min(1.4, this.enrage * 0.7);
        r += k; g -= k * 0.25; b -= k * 0.25;
      }

      const hpFrac = Math.max(0, e.hp / e.maxHp);
      R.glow(e.x, e.y, e.radius * 3.1, r, g, b, 0.30 * alpha, 2.0);
      R.poly(e.x, e.y, e.radius, e.sides, e.angle, r, g, b, alpha);

      if (e.shield > 0) {
        const f = e.shield / e.maxShield;
        R.ring(e.x, e.y, e.radius + 5, 1.4, 0.4, 0.8, 1.6, 0.5 + f * 0.4);
      }
      if (e.boss) {
        R.ring(e.x, e.y, e.radius + 11 + Math.sin(time * 4) * 2, 2.2, 1.6, 0.25, 0.35, 0.85);
        // Boss health arc
        R.ring(e.x, e.y, e.radius + 18, 3.0, 1.5, 0.4, 0.2, 0.25);
        R.ring(e.x, e.y, e.radius + 18, 3.0 * hpFrac, 1.6, 0.5, 0.2, 0.9);
      } else if (hpFrac < 0.999) {
        R.ring(e.x, e.y, e.radius + 4.5, 1.1 * hpFrac, r * 1.3, g * 1.3, b * 1.3, 0.55 * alpha);
      }
    }
  }

  renderBullets() {
    const R = this.renderer;
    const items = this.bullets.items;
    for (let i = 0; i < items.length; i++) {
      const b = items[i];
      if (!b.active) continue;
      const c = b.fromEnemy ? [1.5, 0.5, 0.25] : (b.crit ? [1.6, 1.3, 0.5] : COLORS.bullet);
      const tail = 0.028;
      R.beam(b.x - b.vx * tail, b.y - b.vy * tail, b.x, b.y, b.radius * 1.5,
        c[0], c[1], c[2], 0.85, 0.9);
      R.glow(b.x, b.y, b.radius * 4.2, c[0], c[1], c[2], 0.6, 1.8);
    }
  }

  renderParticles() {
    const R = this.renderer;
    const items = this.particles.items;
    for (let i = 0; i < items.length; i++) {
      const p = items[i];
      if (!p.active) continue;
      const t = p.life / p.maxLife;
      if (p.kind === 3) {
        // Expanding shockwave ring
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
        R.ring(s.x, s.y, 34 + i * 22 + Math.sin(time * 5 - i) * 6, 1.6,
          0.7, 0.4, 1.5, 0.5 - i * 0.09);
      }
    }
    if (this.lance && this.lance.t > 0) {
      const a = this.lance.angle;
      const len = Math.hypot(this.w, this.h);
      R.beam(this.cx, this.cy, this.cx + Math.cos(a) * len, this.cy + Math.sin(a) * len,
        13, 1.6, 0.35, 0.6, 0.9, 0.85);
      R.beam(this.cx, this.cy, this.cx + Math.cos(a) * len, this.cy + Math.sin(a) * len,
        4, 1.8, 1.4, 1.6, 1, 0.6);
    }
    if (this.buffs.aegis > 0) {
      const p = 1 + Math.sin(time * 7) * 0.06;
      R.ring(this.cx, this.cy, 112 * p, 3.5, 0.35, 1.5, 0.85, 0.75);
      R.glow(this.cx, this.cy, 150, 0.25, 1.1, 0.6, 0.28, 2);
    }
  }

  renderTower(time, run, s) {
    const R = this.renderer;
    const cx = this.cx, cy = this.cy;
    const hullFrac = Math.max(0, run.hull / s.maxHull);
    const shieldFrac = s.maxShield > 0 ? run.shield / s.maxShield : 0;
    const over = this.buffs.overdrive > 0;

    // Shield bubble
    if (shieldFrac > 0.01) {
      R.ring(cx, cy, 52 + Math.sin(time * 2.4) * 1.6, 2.2,
        COLORS.shield[0], COLORS.shield[1], COLORS.shield[2], 0.28 + shieldFrac * 0.45);
      R.glow(cx, cy, 66, COLORS.shield[0], COLORS.shield[1], COLORS.shield[2], shieldFrac * 0.18, 2.4);
    }

    // Rotating outer housing
    const tc = over ? [1.5, 0.9, 0.25] : COLORS.tower;
    R.ring(cx, cy, 36, 2.4, tc[0], tc[1], tc[2], 0.75);
    for (let i = 0; i < 3; i++) {
      const a = time * 0.6 + (i / 3) * TAU;
      R.poly(cx + Math.cos(a) * 36, cy + Math.sin(a) * 36, 5.5, 3, a, tc[0], tc[1], tc[2], 0.9);
    }

    // Core, brightness tracking hull integrity
    const beat = 1 + Math.sin(time * 3.2) * 0.05;
    R.glow(cx, cy, 74 * beat, tc[0], tc[1], tc[2], 0.42 * (0.45 + hullFrac * 0.55), 1.7);
    R.disc(cx, cy, 21 * beat, tc[0] * (0.5 + hullFrac), tc[1] * (0.5 + hullFrac), tc[2] * (0.5 + hullFrac), 1);
    R.disc(cx, cy, 11, 1.7, 1.9, 2.0, 1);

    // Barrel pointing at the current target
    const a = this.turretAngle;
    R.beam(cx + Math.cos(a) * 16, cy + Math.sin(a) * 16,
      cx + Math.cos(a) * 40, cy + Math.sin(a) * 40, 5.5, tc[0], tc[1], tc[2], 0.95, 0.5);

    // Orbiting escort drones
    for (let i = 0; i < s.drones; i++) {
      const da = this.droneAngle + (i / s.drones) * TAU;
      const dx = cx + Math.cos(da) * 74, dy = cy + Math.sin(da) * 74;
      R.glow(dx, dy, 16, tc[0], tc[1], tc[2], 0.5, 1.8);
      R.poly(dx, dy, 6, 3, da * 3, tc[0], tc[1], tc[2], 1);
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
  let tier = Math.floor(Math.log10(n) / 3);
  if (tier > units.length) return n.toExponential(1);
  const v = n / Math.pow(1000, tier);
  return (v < 10 ? v.toFixed(1) : Math.round(v)) + units[tier - 1];
}

export { COLORS };
