// VOID BASTION — balance model.
//
// Every number that decides whether the game is fun lives in this file, and
// nothing in here touches the DOM or the renderer. tools/simulate.mjs imports
// this module directly and plays thousands of simulated waves against it, so
// the formulas below are tuned rather than guessed. If you change a constant,
// re-run `node tools/simulate.mjs` before you trust it.
//
// The shape of the progression, in one paragraph: enemy HP is polynomial-first
// and exponential-second, so the early game ramps gently and the late game
// never stops climbing. Player power comes from several independent stats that
// MULTIPLY together (damage x fire rate x crit x multishot), so a player who
// spreads upgrades sensibly outruns a curve that any single stat could not.
// In-run upgrade costs grow exponentially against linear stat gains, which
// soft-caps each run without ever hard-blocking it. Permanent Lab research
// then lifts the whole baseline, which is what makes run N+1 feel different
// from run N instead of merely longer.

// ---------------------------------------------------------------------------
// Wave composition
// ---------------------------------------------------------------------------

// The exponential base of enemy HP. Nearly every other constant in this file
// is tuned against this one, so it is named rather than inlined.
export const HP_BASE = 1.036;

/** Enemy hull for a normal enemy on the given wave. */
export function enemyHP(wave) {
  // w^1.75 dominates until ~wave 80, then HP_BASE^w takes over and never stops.
  return 9 * Math.pow(wave, 1.75) * Math.pow(HP_BASE, wave);
}

/** How many enemies a wave sends in total. */
export function enemyCount(wave) {
  // sqrt-led so the screen stays readable; the linear term keeps late waves busy.
  return Math.floor(5 + 2.4 * Math.sqrt(wave) + wave * 0.14);
}

/**
 * Seconds over which a wave's enemies are released.
 *
 * Deliberately a function of the WAVE and not of the enemy count: if the
 * interval were a fixed per-enemy delay, late waves with 100+ enemies would
 * take minutes to even finish spawning. Budgeting a window instead keeps every
 * wave to roughly the same comfortable length while the pressure per second
 * rises naturally with the count.
 */
export function spawnWindow(wave) {
  return 7 + 5 * Math.log10(wave + 1);
}

/** Movement speed in world units/sec. Deliberately near-flat. */
export function enemySpeed(wave) {
  // Speed is the one stat we do NOT let run away: past a point, faster enemies
  // stop being "harder" and start being "unreadable". Log growth, hard ceiling.
  return Math.min(78, 24 + 11 * Math.log10(wave + 1));
}

/** Contact damage an enemy deals to the bastion hull. */
export function enemyDamage(wave) {
  return 6 * Math.pow(wave, 1.25) * Math.pow(1.028, wave);
}

/** Coins dropped by one normal kill on this wave, before player multipliers. */
export function coinValue(wave) {
  // Tied to HP by a fractional exponent. Sub-linear on purpose: coin income
  // must lag raw enemy HP so that permanent Lab research stays the thing that
  // unlocks new depth, rather than in-run grinding solving everything.
  return 2.2 * Math.pow(enemyHP(wave), 0.55);
}

/** Flat bonus for surviving a wave. */
export function waveClearBonus(wave) {
  return 14 * Math.pow(wave, 1.12) * Math.pow(1.03, wave);
}

export const BOSS_INTERVAL = 10;
export const isBossWave = (wave) => wave % BOSS_INTERVAL === 0;

/** Boss stat block, derived from the wave it appears on. */
export function bossStats(wave) {
  const tier = Math.floor(wave / BOSS_INTERVAL); // 1, 2, 3, ...
  return {
    hp: enemyHP(wave) * (13 + tier * 1.6),
    speed: enemySpeed(wave) * 0.52,
    damage: enemyDamage(wave) * 2.4,
    radius: 26 + Math.min(16, tier * 0.9),
    coins: coinValue(wave) * (11 + tier * 1.3),
  };
}

// ---------------------------------------------------------------------------
// Enemy archetypes
// ---------------------------------------------------------------------------
// Each archetype is a multiplier set over the wave baseline plus a weight
// controlling how often it shows up. `from` gates an archetype behind a wave so
// the first few minutes stay legible while the roster opens up over time.

export const ARCHETYPES = {
  drone:    { name: 'Drone',    from: 1,  weight: 100, hp: 1.00, speed: 1.00, dmg: 1.00, coin: 1.00, radius: 11, sides: 3 },
  darter:   { name: 'Darter',   from: 4,  weight: 42,  hp: 0.45, speed: 1.85, dmg: 0.70, coin: 0.85, radius: 9,  sides: 4 },
  brute:    { name: 'Brute',    from: 8,  weight: 34,  hp: 3.40, speed: 0.60, dmg: 2.10, coin: 2.60, radius: 17, sides: 6 },
  splitter: { name: 'Splitter', from: 14, weight: 26,  hp: 1.30, speed: 0.88, dmg: 1.00, coin: 1.30, radius: 14, sides: 5 },
  shielder: { name: 'Shielder', from: 20, weight: 24,  hp: 1.60, speed: 0.78, dmg: 1.20, coin: 1.90, radius: 14, sides: 6, shield: 1.5 },
  sentinel: { name: 'Sentinel', from: 28, weight: 20,  hp: 1.10, speed: 0.70, dmg: 1.40, coin: 1.80, radius: 12, sides: 4, ranged: true },
  wraith:   { name: 'Wraith',   from: 45, weight: 18,  hp: 0.90, speed: 1.30, dmg: 1.30, coin: 2.20, radius: 11, sides: 3, phase: true },
};

/** Archetypes legal on a wave, with weights ramped in so they appear gradually. */
export function spawnTable(wave) {
  const out = [];
  for (const [key, a] of Object.entries(ARCHETYPES)) {
    if (wave < a.from) continue;
    // Ramp weight over 6 waves after unlock — a new enemy trickles in rather
    // than suddenly being a third of the wave.
    const ramp = Math.min(1, (wave - a.from + 1) / 6);
    out.push({ key, arch: a, weight: a.weight * ramp });
  }
  return out;
}

// ---------------------------------------------------------------------------
// In-run upgrades (bought with Coins, reset every run)
// ---------------------------------------------------------------------------
// `base`  — cost of level 1
// `growth`— cost multiplier per level; the soft cap knob
// `add`   — how much one level adds to the stat
// Effects are ADDITIVE against EXPONENTIAL cost. That produces the classic
// idle-game decay: every level is worth buying, each is worth a little less.

export const UPGRADES = {
  damage:      { tab: 'offense', name: 'Plasma Yield',    desc: 'Damage per shot',            base: 22,   growth: 1.125, add: 5.5,   fmt: 'flat' },
  fireRate:    { tab: 'offense', name: 'Cycle Rate',      desc: 'Shots per second',           base: 40,   growth: 1.145, add: 0.11,  fmt: 'rate' },
  critChance:  { tab: 'offense', name: 'Targeting AI',    desc: 'Critical hit chance',        base: 90,   growth: 1.165, add: 0.014, fmt: 'pct', cap: 0.75, maxLevel: 52 },
  critMult:    { tab: 'offense', name: 'Overcharge',      desc: 'Critical damage multiplier', base: 130,  growth: 1.155, add: 0.16,  fmt: 'mult' },
  multishot:   { tab: 'offense', name: 'Split Barrel',    desc: 'Extra projectiles per shot', base: 420,  growth: 1.30,  add: 1,     fmt: 'int', cap: 7, maxLevel: 7 },
  pierce:      { tab: 'offense', name: 'Rail Coil',       desc: 'Enemies pierced per shot',   base: 380,  growth: 1.34,  add: 1,     fmt: 'int', cap: 9, maxLevel: 9 },
  range:       { tab: 'offense', name: 'Sensor Array',    desc: 'Targeting range',            base: 55,   growth: 1.135, add: 9,     fmt: 'flat' },

  maxHull:     { tab: 'defense', name: 'Hull Plating',    desc: 'Maximum hull',               base: 30,   growth: 1.13,  add: 42,    fmt: 'flat' },
  regen:       { tab: 'defense', name: 'Nanorepair',      desc: 'Hull regenerated per sec',   base: 65,   growth: 1.15,  add: 3.2,   fmt: 'rate' },
  shieldMax:   { tab: 'defense', name: 'Deflector',       desc: 'Shield capacity',            base: 70,   growth: 1.14,  add: 30,    fmt: 'flat' },
  shieldRegen: { tab: 'defense', name: 'Capacitor',       desc: 'Shield recharged per sec',   base: 95,   growth: 1.155, add: 2.4,   fmt: 'rate' },
  armor:       { tab: 'defense', name: 'Ablative Mesh',   desc: 'Incoming damage reduction',  base: 220,  growth: 1.19,  add: 0.011, fmt: 'pct', cap: 0.70, maxLevel: 64 },
  thorns:      { tab: 'defense', name: 'Reactive Spikes', desc: 'Damage reflected on contact',base: 160,  growth: 1.17,  add: 0.22,  fmt: 'mult' },

  coinBonus:   { tab: 'utility', name: 'Salvage Rig',     desc: 'Coins from every source',    base: 150,  growth: 1.20,  add: 0.075, fmt: 'pctBonus' },
  slowField:   { tab: 'utility', name: 'Grav Well',       desc: 'Enemy speed reduction',      base: 190,  growth: 1.21,  add: 0.016, fmt: 'pct', cap: 0.60, maxLevel: 37 },
  drones:      { tab: 'utility', name: 'Escort Drones',   desc: 'Orbiting auto-turrets',      base: 900,  growth: 1.55,  add: 1,     fmt: 'int', cap: 6, maxLevel: 6 },
  lifesteal:   { tab: 'utility', name: 'Siphon Core',     desc: 'Hull restored per kill',     base: 260,  growth: 1.185, add: 0.9,   fmt: 'flat' },
};

/** Cost of buying the NEXT level of an upgrade currently at `level`. */
export function upgradeCost(key, level) {
  const u = UPGRADES[key];
  return Math.ceil(u.base * Math.pow(u.growth, level));
}

/** Total cost of buying `n` levels starting from `level` (geometric series). */
export function upgradeBulkCost(key, level, n) {
  const u = UPGRADES[key];
  const r = u.growth;
  return Math.ceil(u.base * Math.pow(r, level) * (Math.pow(r, n) - 1) / (r - 1));
}

/** How many levels of `key` are affordable with `coins`, capped by `max`. */
export function affordableLevels(key, level, coins, max = 1e9) {
  const u = UPGRADES[key];
  const r = u.growth;
  const headroom = upgradeMaxLevel(key) - level;
  if (headroom <= 0) return 0;
  const c0 = u.base * Math.pow(r, level);
  if (coins < c0) return 0;
  // Invert the geometric series: n = log_r(1 + coins*(r-1)/c0)
  const n = Math.floor(Math.log(1 + (coins * (r - 1)) / c0) / Math.log(r));
  return Math.max(0, Math.min(n, max, headroom));
}

/** Level ceiling for an upgrade, or Infinity if it scales forever. */
export function upgradeMaxLevel(key) {
  const m = UPGRADES[key].maxLevel;
  return m == null ? Infinity : m;
}

// ---------------------------------------------------------------------------
// Permanent Lab research (bought with Cores, survives prestige)
// ---------------------------------------------------------------------------

// Lab bonuses COMPOUND (`mul` is per-level multiplicative), unlike the in-run
// upgrades which are additive. This is the single most important asymmetry in
// the game's economy and it is worth being explicit about why:
//
// Enemy HP grows exponentially in the wave number. An in-run stat that grows
// linearly with levels bought can never catch that, which is exactly why runs
// end — and runs *should* end. But the meta layer has to grow exponentially in
// the number of prestiges, or each prestige buys you fewer and fewer extra
// waves until progression flatlines. Compounding lab bonuses, paid for with a
// Core reward that is itself exponential in wave reached (see coresForRun),
// are what make "+N waves per prestige" hold steady forever instead of decaying
// to zero. An earlier additive version of this table plateaued at +0 by run 8.
export const LAB = {
  labDamage:    { name: 'Fusion Theory',    desc: 'Bastion damage',              base: 3,  growth: 1.16, mul: 1.09 },
  labFireRate:  { name: 'Chrono Tuning',    desc: 'Bastion fire rate',           base: 4,  growth: 1.17, mul: 1.07 },
  labHull:      { name: 'Alloy Science',    desc: 'Bastion hull & shields',      base: 3,  growth: 1.16, mul: 1.10 },
  labCoins:     { name: 'Market Analysis',  desc: 'Coin income',                 base: 5,  growth: 1.18, mul: 1.08 },
  labCrit:      { name: 'Neural Targeting', desc: 'Critical damage',             base: 9,  growth: 1.19, mul: 1.06 },
  labStartCash: { name: 'Requisition',      desc: 'Coins at run start',          base: 4,  growth: 1.22, mul: 2.10, flatBase: 220 },
  labStartWave: { name: 'Forward Deploy',   desc: 'Waves skipped at run start',  base: 20, growth: 1.33, add: 4 },
  // Run length grows with depth (a wave's spawn window widens with log(wave)),
  // so without this a late run would be a two-hour sit. Buying time compression
  // is the standard idle-game answer and it is strictly quality-of-life, so it
  // is priced low and deliberately does not touch any reward.
  labSpeed:     { name: 'Temporal Rig',     desc: 'Maximum simulation speed',    base: 40, growth: 3.20, add: 1, maxLevel: 3 },
  labCoreYield: { name: 'Core Extraction',  desc: 'Cores earned per run',        base: 30, growth: 1.30, mul: 1.12 },
  labOffline:   { name: 'Autopilot',        desc: 'Offline coin generation',     base: 25, growth: 1.28, mul: 1.25 },
};

export function labCost(key, level) {
  const l = LAB[key];
  return Math.ceil(l.base * Math.pow(l.growth, level));
}

/** Compounding multiplier from a lab track at `level`. */
export function labMult(key, level) {
  const l = LAB[key];
  return Math.pow(l.mul, level || 0);
}

/** Coins granted at the start of a run by Requisition. */
export function startingCoins(level) {
  if (!level) return 0;
  return LAB.labStartCash.flatBase * (Math.pow(LAB.labStartCash.mul, level) - 1);
}

/** Wave a new run begins on. */
export function startingWave(level) {
  return 1 + LAB.labStartWave.add * (level || 0);
}

/** Speed steps the player may select, widened by Temporal Rig. */
export function speedOptions(labSpeedLevel = 0) {
  return [1, 2, 3, 4].slice(0, 2 + Math.min(2, labSpeedLevel || 0));
}

// Abilities are one-time Core unlocks, then free to use on cooldown forever.
export const ABILITIES = {
  overdrive: { name: 'Overdrive',     desc: '+150% fire rate',            cost: 8,   cd: 26, dur: 8,   key: '1', color: [1.0, 0.75, 0.2] },
  nova:      { name: 'Nova Pulse',    desc: 'Damages every enemy on screen', cost: 20, cd: 34, dur: 0.5, key: '2', color: [0.4, 0.9, 1.0] },
  aegis:     { name: 'Aegis Field',   desc: 'Full shield + brief immunity', cost: 34, cd: 40, dur: 4,  key: '3', color: [0.5, 1.0, 0.7] },
  singularity:{name: 'Singularity',   desc: 'Pulls and holds the swarm',   cost: 60,  cd: 46, dur: 5,  key: '4', color: [0.75, 0.5, 1.0] },
  lance:     { name: 'Orbital Lance', desc: 'Sweeping beam from orbit',    cost: 95,  cd: 52, dur: 4,  key: '5', color: [1.0, 0.4, 0.6] },
};

// ---------------------------------------------------------------------------
// Prestige
// ---------------------------------------------------------------------------

// Cores are EXPONENTIAL in the wave reached, mirroring the exponential in
// enemyHP. The relationship that keeps prestige gains from decaying is
//
//     ln(CORE_BASE) ≈ ln(HP_BASE) · ln(labGrowth) / ln(labMul)
//
// i.e. the reward for surviving one more wave has to buy back exactly the lab
// levels needed to beat one more wave's worth of enemy HP. Plugging in
// HP_BASE 1.036, lab cost growth ~1.16 and lab multiplier ~1.13 gives ~1.043.
// Sitting a hair above that keeps per-prestige gains flat-to-slightly-growing.
// Held in a mutable object so tools/simulate.mjs can sweep it without the game
// and the harness drifting apart. Nothing at runtime writes to this.
// CORE_BASE was chosen by `node tools/simulate.mjs --sweep`. It is the single
// most sensitive constant in the game: it sets how fast the meta layer grows
// against the exponential in enemyHP.
//
//   1.011  →  drift 0.72, gains decaying toward a plateau
//   1.016  →  drift ~1.4, steady +16ish waves per prestige      <-- here
//   1.019  →  drift 2.27, gains accelerating
//   1.024+ →  runaway; the player outruns the curve entirely
//
// "drift" is tail-half mean wave gain over head-half mean wave gain. Anything
// in roughly 0.9–1.6 feels like healthy infinite progression.
export const TUNING = { CORE_BASE: 1.016, CORE_SCALE: 0.42 };

/** Cores awarded for a run that reached `maxWave`. */
export function coresForRun(maxWave, coreYieldLevel = 0) {
  if (maxWave < 5) return 0;
  const yieldMult = labMult('labCoreYield', coreYieldLevel);
  return Math.floor(
    TUNING.CORE_SCALE * Math.pow(TUNING.CORE_BASE, maxWave) * Math.pow(maxWave, 0.9) * yieldMult
  );
}

/** Permanent multiplier just for having prestiged `n` times, on top of the Lab. */
export function ascensionMult(n) {
  // Small next to the Lab, but unbounded — a visible reward for the act of
  // ascending itself, so an early prestige never feels like pure loss.
  return 1 + 0.14 * Math.pow(n, 0.9);
}

// ---------------------------------------------------------------------------
// Derived player stats
// ---------------------------------------------------------------------------
// One function, one source of truth. The game reads this every frame-ish and
// the simulator reads the exact same thing.

export function deriveStats(up, lab, prestigeCount) {
  const asc = ascensionMult(prestigeCount);
  const dmgMult  = labMult('labDamage',   lab.labDamage)   * asc;
  const rateMult = labMult('labFireRate', lab.labFireRate);
  const hullMult = labMult('labHull',     lab.labHull)     * asc;
  const coinMult = labMult('labCoins',    lab.labCoins);
  const critLab  = labMult('labCrit',     lab.labCrit);

  const lv = (k) => up[k] || 0;
  const U = UPGRADES;

  const critChance = Math.min(U.critChance.cap, 0.03 + U.critChance.add * lv('critChance'));
  const critMult   = (1.6 + U.critMult.add * lv('critMult')) * critLab;

  const damage   = (12 + U.damage.add * lv('damage')) * dmgMult;
  const fireRate = (1.6 + U.fireRate.add * lv('fireRate')) * rateMult;
  const shots    = 1 + Math.min(U.multishot.cap, lv('multishot'));
  const pierce   = 1 + Math.min(U.pierce.cap, lv('pierce'));

  // Effective single-target DPS, used by the simulator and the HUD readout.
  const critFactor = 1 + critChance * (critMult - 1);
  const dps = damage * fireRate * shots * critFactor;

  return {
    damage, fireRate, shots, pierce, critChance, critMult, dps,
    range:       190 + U.range.add * lv('range'),
    maxHull:     (220 + U.maxHull.add * lv('maxHull')) * hullMult,
    regen:       (1.5 + U.regen.add * lv('regen')) * hullMult,
    maxShield:   (0 + U.shieldMax.add * lv('shieldMax')) * hullMult,
    shieldRegen: (2 + U.shieldRegen.add * lv('shieldRegen')) * hullMult,
    armor:       Math.min(U.armor.cap, U.armor.add * lv('armor')),
    thorns:      U.thorns.add * lv('thorns'),
    coinMult:    coinMult * (1 + U.coinBonus.add * lv('coinBonus')),
    slowField:   Math.min(U.slowField.cap, U.slowField.add * lv('slowField')),
    drones:      Math.min(U.drones.cap, lv('drones')),
    lifesteal:   U.lifesteal.add * lv('lifesteal'),
  };
}

// ---------------------------------------------------------------------------
// Number formatting — shared by HUD and simulator so they never disagree.
// ---------------------------------------------------------------------------

const SUFFIX = ['', 'K', 'M', 'B', 'T', 'aa', 'ab', 'ac', 'ad', 'ae', 'af', 'ag',
                'ah', 'ai', 'aj', 'ak', 'al', 'am', 'an', 'ao', 'ap', 'aq'];

export function fmt(n) {
  if (!isFinite(n)) return '∞';
  if (n < 0) return '-' + fmt(-n);
  if (n < 1000) return n < 10 && n % 1 !== 0 ? n.toFixed(1) : String(Math.floor(n));
  const tier = Math.floor(Math.log10(n) / 3);
  if (tier >= SUFFIX.length) return n.toExponential(2);
  const scaled = n / Math.pow(1000, tier);
  return (scaled < 10 ? scaled.toFixed(2) : scaled < 100 ? scaled.toFixed(1) : Math.floor(scaled)) + SUFFIX[tier];
}
