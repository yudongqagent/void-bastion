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

// ---------------------------------------------------------------------------
// Difficulty
// ---------------------------------------------------------------------------
// Each tier unlocks by reaching UNLOCK_LEVEL on the one below it. Enemies get
// tougher and Cores pay more, and the payout is deliberately set ABOVE the
// break-even point rather than at it.
//
// The sums: enemy hull at level L scales as 1.193^L, so a hull multiplier M
// costs you ln(M)/ln(1.193) levels of depth. Cores scale as 1.083^L, so those
// lost levels cost 1.083^(that many) in payout. Veteran's 2.2x hull costs about
// 4.5 levels, worth ~1.43x cores — so 2.6x makes the switch worth roughly 1.8x
// per run. Every tier above clears its own bar by a wider margin, which is what
// makes moving up the correct play rather than a vanity setting.
export const UNLOCK_LEVEL = 100;

export const DIFFICULTIES = [
  { id: 'normal',    name: 'NORMAL',    hp: 1.0,  dmg: 1.00, cores: 1.0,  blurb: 'The baseline campaign.' },
  { id: 'veteran',   name: 'VETERAN',   hp: 2.2,  dmg: 1.30, cores: 2.6,  blurb: 'Tougher hulls, better salvage.' },
  { id: 'elite',     name: 'ELITE',     hp: 5.0,  dmg: 1.70, cores: 7.0,  blurb: 'Armoured swarms. Cores flow.' },
  { id: 'nightmare', name: 'NIGHTMARE', hp: 12.0, dmg: 2.20, cores: 20.0, blurb: 'Everything hits back harder.' },
  { id: 'void',      name: 'VOID',      hp: 30.0, dmg: 3.00, cores: 60.0, blurb: 'For bastions with nothing left to prove.' },
];

export function difficulty(index) {
  return DIFFICULTIES[Math.max(0, Math.min(DIFFICULTIES.length - 1, index || 0))];
}

/** Highest tier the player has earned, from their best level on each tier. */
export function unlockedDifficulty(bestByDiff = []) {
  let unlocked = 0;
  for (let i = 0; i < DIFFICULTIES.length - 1; i++) {
    if ((bestByDiff[i] || 0) >= UNLOCK_LEVEL) unlocked = i + 1;
    else break;
  }
  return unlocked;
}

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
  // Budgeted so four phases plus a boss come to roughly ninety seconds.
  return 6 + 3.4 * Math.log10(wave + 1);
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

/**
 * Balance interest is paid on, capped relative to the current stage.
 *
 * Without a ceiling the correct play at any depth is to stop buying entirely
 * and let a growing pile compound, which is not a decision so much as an
 * exploit. Tying the cap to the wave-clear bonus keeps banking worthwhile at
 * every stage without ever making it the only thing worth doing.
 */
export function interestPrincipal(wave, coins) {
  return Math.min(coins, waveClearBonus(wave) * 45);
}

export const BOSS_INTERVAL = 5;
export const isBossWave = (wave) => wave % BOSS_INTERVAL === 0;

/** Boss stat block, derived from the wave it appears on. */
export function bossStats(wave) {
  const tier = Math.floor(wave / BOSS_INTERVAL); // 1, 2, 3, ...
  return {
    hp: enemyHP(wave) * (9 + tier * 1.1),
    speed: enemySpeed(wave) * 0.52,
    damage: enemyDamage(wave) * 2.4,
    radius: 26 + Math.min(16, tier * 0.9),
    coins: coinValue(wave) * (8 + tier * 1.0),
  };
}

// ---------------------------------------------------------------------------
// Enemy archetypes
// ---------------------------------------------------------------------------
// Each archetype is a multiplier set over the wave baseline plus a weight
// controlling how often it shows up. `from` gates an archetype behind a wave so
// the first few minutes stay legible while the roster opens up over time.

// Ground emplacements ride the terrain instead of flying at you: they scroll
// down with the world, shoot while they can, and are gone if you let them pass.
export const GROUND_TYPES = new Set(['turret', 'tank', 'warship', 'sam']);

export const ARCHETYPES = {
  //         from  weight decay   hp    speed  dmg   coin  radius sides  weapon
  drone:    { name: 'Drone',       from: 1,   weight: 100, decay: 90,  hp: 1.00, speed: 1.00, dmg: 1.00, coin: 1.00, radius: 11, sides: 3 },
  darter:   { name: 'Darter',      from: 4,   weight: 42,  decay: 110, hp: 0.45, speed: 1.85, dmg: 0.70, coin: 0.85, radius: 9,  sides: 4 },
  brute:    { name: 'Brute',       from: 8,   weight: 34,  decay: 150, hp: 3.40, speed: 0.60, dmg: 2.10, coin: 2.60, radius: 17, sides: 6 },
  splitter: { name: 'Splitter',    from: 14,  weight: 26,  decay: 180, hp: 1.30, speed: 0.88, dmg: 1.00, coin: 1.30, radius: 14, sides: 5 },
  shielder: { name: 'Shielder',    from: 20,  weight: 24,  decay: 220, hp: 1.60, speed: 0.78, dmg: 1.20, coin: 1.90, radius: 14, sides: 6, shield: 1.5 },
  sentinel: { name: 'Sentinel',    from: 28,  weight: 22,  decay: 240, hp: 1.10, speed: 0.70, dmg: 1.40, coin: 1.80, radius: 12, sides: 4, weapon: 'aimed' },
  gunship:  { name: 'Gunship',     from: 34,  weight: 24,  decay: 300, hp: 1.90, speed: 0.62, dmg: 1.50, coin: 2.50, radius: 15, sides: 5, weapon: 'homing' },
  wraith:   { name: 'Wraith',      from: 45,  weight: 20,  decay: 320, hp: 0.90, speed: 1.30, dmg: 1.30, coin: 2.20, radius: 11, sides: 3, phase: true },
  radial:   { name: 'Radial Gun',  from: 56,  weight: 24,  decay: 400, hp: 2.40, speed: 0.50, dmg: 1.60, coin: 3.10, radius: 16, sides: 8, weapon: 'radial' },
  lancer:   { name: 'Lancer',      from: 78,  weight: 22,  decay: 460, hp: 2.00, speed: 0.55, dmg: 1.90, coin: 3.40, radius: 14, sides: 4, weapon: 'beam' },
  dread:    { name: 'Dreadnought', from: 110, weight: 20,  decay: 999, hp: 5.50, speed: 0.45, dmg: 2.60, coin: 5.20, radius: 22, sides: 6, shield: 2.0, weapon: 'spread' },

  // --- extremes ------------------------------------------------------------
  // Deliberately spread far wider in hull and damage than the core roster. A
  // swarm where everything has roughly one unit of health and deals roughly one
  // unit of damage is uniform no matter how many shapes it wears; these are the
  // ones that make a wave feel like it has a composition.
  mite:     { name: 'Mite',        from: 3,   weight: 44,  decay: 240, hp: 0.14, speed: 2.10, dmg: 0.30, coin: 0.30, radius: 7,  sides: 3, pack: 4 },
  bomber:   { name: 'Bomber',      from: 18,  weight: 26,  decay: 340, hp: 0.55, speed: 1.15, dmg: 5.50, coin: 2.20, radius: 13, sides: 4, blast: 78 },
  juggernaut:{name: 'Juggernaut',  from: 40,  weight: 18,  decay: 999, hp: 14.0, speed: 0.34, dmg: 1.30, coin: 7.50, radius: 26, sides: 7 },
  sniper:   { name: 'Rail Sniper', from: 48,  weight: 20,  decay: 520, hp: 0.85, speed: 0.55, dmg: 4.20, coin: 2.90, radius: 11, sides: 3, weapon: 'rail', standoff: 0.14 },
  warden:   { name: 'Warden',      from: 64,  weight: 18,  decay: 999, hp: 3.20, speed: 0.62, dmg: 0.80, coin: 4.60, radius: 16, sides: 6, aura: 150 },

  // --- ground emplacements ------------------------------------------------
  turret:   { name: 'AA Turret',   from: 12,  weight: 24,  decay: 300, hp: 1.60, speed: 0, dmg: 1.10, coin: 1.90, radius: 13, sides: 8, weapon: 'aimed',  ground: true },
  tank:     { name: 'Gun Tank',    from: 24,  weight: 22,  decay: 340, hp: 2.60, speed: 0, dmg: 1.40, coin: 2.70, radius: 14, sides: 4, weapon: 'aimed',  ground: true },
  warship:  { name: 'Patrol Boat', from: 38,  weight: 20,  decay: 420, hp: 3.40, speed: 0, dmg: 1.60, coin: 3.40, radius: 19, sides: 4, weapon: 'spread', ground: true },
  sam:      { name: 'SAM Battery', from: 62,  weight: 18,  decay: 999, hp: 3.00, speed: 0, dmg: 1.90, coin: 4.00, radius: 15, sides: 6, weapon: 'homing', ground: true },
};

/**
 * Muted hull colours with one bright accent each.
 *
 * Flat neon made every craft a coloured blob; with distinct silhouettes doing
 * the identification work, hulls can be military greys and olives lit by the
 * key light, and colour goes where colour belongs — running lights, cockpits
 * and engine glow.
 */
export const HULLS = {
  drone:    { hull: [0.34, 0.36, 0.40], accent: [1.50, 0.35, 0.45] },
  darter:   { hull: [0.42, 0.38, 0.28], accent: [1.55, 0.95, 0.25] },
  brute:    { hull: [0.30, 0.31, 0.38], accent: [0.85, 0.45, 1.60] },
  splitter: { hull: [0.28, 0.36, 0.31], accent: [0.30, 1.50, 0.70] },
  shielder: { hull: [0.30, 0.34, 0.42], accent: [0.40, 0.80, 1.60] },
  sentinel: { hull: [0.40, 0.34, 0.26], accent: [1.55, 0.62, 0.22] },
  wraith:   { hull: [0.26, 0.25, 0.32], accent: [0.95, 0.75, 1.60] },
  gunship:  { hull: [0.33, 0.35, 0.31], accent: [1.45, 0.75, 0.30] },
  radial:   { hull: [0.36, 0.30, 0.30], accent: [1.55, 0.40, 0.35] },
  lancer:   { hull: [0.30, 0.33, 0.37], accent: [1.55, 0.45, 0.55] },
  dread:    { hull: [0.27, 0.29, 0.33], accent: [1.50, 0.55, 0.30] },
  turret:   { hull: [0.35, 0.37, 0.33], accent: [1.45, 0.70, 0.25] },
  tank:     { hull: [0.32, 0.35, 0.27], accent: [1.40, 0.80, 0.30] },
  warship:  { hull: [0.30, 0.33, 0.36], accent: [1.45, 0.55, 0.30] },
  sam:      { hull: [0.34, 0.33, 0.30], accent: [1.55, 0.35, 0.35] },
  mite:     { hull: [0.38, 0.36, 0.30], accent: [1.45, 1.20, 0.30] },
  bomber:   { hull: [0.40, 0.30, 0.26], accent: [1.60, 0.42, 0.14] },
  juggernaut:{hull:[0.30, 0.32, 0.34], accent: [1.30, 0.60, 1.55] },
  sniper:   { hull: [0.26, 0.30, 0.34], accent: [1.55, 0.25, 0.40] },
  warden:   { hull: [0.28, 0.34, 0.36], accent: [0.35, 1.50, 1.25] },
  boss:     { hull: [0.34, 0.26, 0.28], accent: [1.60, 0.30, 0.35] },
};

export function hullFor(type) { return HULLS[type] || HULLS.drone; }

/**
 * Archetypes legal on a wave, with weights ramped in AND decayed out.
 *
 * The ramp keeps a newly unlocked enemy from being a third of the wave the
 * moment it appears. The decay is the more important half: without it, basic
 * Drones stay the single most common enemy at wave 300, so the swarm never
 * actually changes character no matter how deep you get. Each archetype fades
 * toward a floor over `decay` waves, so the roster's centre of mass drifts
 * steadily toward the heavy, armed end of the table.
 */
export function spawnTable(wave) {
  const out = [];
  for (const [key, a] of Object.entries(ARCHETYPES)) {
    if (wave < a.from) continue;
    const ramp = Math.min(1, (wave - a.from + 1) / 6);
    const fade = Math.max(0.10, 1 - (wave - a.from) / (a.decay || 200));
    const weight = a.weight * ramp * fade;
    if (weight <= 0.01) continue;
    out.push({ key, arch: a, weight });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Elites
// ---------------------------------------------------------------------------
// Ramming is nearly free damage against a dodging autopilot, so raw contact
// numbers are a dead difficulty knob (sweeping them 3x moved run depth by
// noise). Pressure has to come from things that cannot be side-stepped:
// projectiles, and lots of them. Elites are the delivery mechanism — a rising
// share of the swarm that is tougher, hits harder, pays far better, and always
// carries a weapon even if its base archetype does not.

export const ELITE = {
  hp: 2.6, dmg: 1.45, coin: 3.0, radius: 1.22, speed: 0.9,
  /** Weapon handed to an elite whose archetype has none of its own. */
  fallbackWeapon: 'burst',
};

/** Fraction of a wave that spawns as elites. */
export function eliteChance(wave) {
  if (wave < 22) return 0;
  return Math.min(0.40, (wave - 22) / 300);
}

// ---------------------------------------------------------------------------
// Enemy weapons
// ---------------------------------------------------------------------------
// `dmg` is a multiplier on the firing enemy's contact damage. Values above 1
// are deliberate: a shot you have to dodge should hurt more than a body you
// merely bumped into, or there is no reason to fear the armed enemies.

export const WEAPONS = {
  aimed:  { cd: 2.1, dmg: 1.3, speed: 270, count: 1,  spread: 0 },
  burst:  { cd: 2.9, dmg: 1.0, speed: 430, count: 3,  spread: 0,    gap: 0.12, homing: 0.55, drag: 0.42 },
  spread: { cd: 2.4, dmg: 1.1, speed: 240, count: 5,  spread: 0.44 },
  homing: { cd: 3.0, dmg: 1.9, speed: 150, count: 2,  spread: 0.30, homing: 1.8, life: 7 },
  radial: { cd: 2.2, dmg: 0.9, speed: 200, count: 9,  spread: 0,    spiral: true },
  rail:   { cd: 3.6, dmg: 2.4, speed: 540, count: 1,  spread: 0 },
  beam:   { cd: 4.2, dmg: 2.6, telegraph: 0.85, duration: 0.55, width: 26 },
};

// ---------------------------------------------------------------------------
// In-run upgrades (bought with Coins, reset every run)
// ---------------------------------------------------------------------------
// `base`  — cost of level 1
// `growth`— cost multiplier per level; the soft cap knob
// `add`   — how much one level adds to the stat
// Effects are ADDITIVE against EXPONENTIAL cost. That produces the classic
// idle-game decay: every level is worth buying, each is worth a little less.

export const UPGRADES = {
  // 24 rather than 13: Rail Coil was removed for readability, and it had been
  // carrying real damage — a shot through three enemies is three hits. Career
  // depth fell ~20% without it, and +31% damage recovered only part of that,
  // so its throughput is folded into the base gun
  // instead of quietly making the game harder.
  damage:      { tab: 'offense', label: 'dmg', name: 'Plasma Yield',    desc: 'Damage per shot',            curve: 'lin', base: 26,    step: 15,   add: 24,    fmt: 'flat' },
  fireRate:    { tab: 'offense', label: 'rate', name: 'Cycle Rate',      desc: 'Shots per second',           base: 40,   growth: 1.145, add: 0.11,  fmt: 'rate' },
  critChance:  { tab: 'offense', label: 'crit', name: 'Targeting AI',    desc: 'Critical hit chance',        base: 90,   growth: 1.165, add: 0.014, fmt: 'pct', cap: 0.75, maxLevel: 52 },
  critMult:    { tab: 'offense', label: 'crit dmg', name: 'Overcharge',      desc: 'Critical damage multiplier', base: 130,  growth: 1.155, add: 0.16,  fmt: 'mult' },
  // Capped at three barrels. Nine filled the lane edge to edge, which removed
  // any reason to aim or position and turned the screen into a wall of tracer.
  multishot:   { tab: 'offense', label: 'shots', name: 'Split Barrel',    desc: 'Extra projectiles per shot', base: 620,  growth: 1.42,  add: 1,     fmt: 'int', cap: 2, maxLevel: 2 },

  // --- weapon systems: level 0 means "not owned yet" ---------------------
  laser:      { tab: 'offense' , tint: 'laser', label: 'laser',    name: 'Pulse Laser',    desc: 'Continuous beam on your target',   curve: 'lin', base: 1300, step: 160, add: 360, fmt: 'flat' },
  missiles:      { tab: 'offense' , tint: 'missile', label: 'missile',  name: 'Seeker Pod',     desc: 'Homing missiles, more per level',  curve: 'lin', base: 1550, step: 190, add: 190, fmt: 'flat' },
  flak:      { tab: 'offense' , tint: 'flak', label: 'flak',     name: 'Flak Cannon',    desc: 'Airbursts over enemy clusters',    curve: 'lin', base: 1500, step: 190, add: 300, fmt: 'flat' },
  arc:      { tab: 'offense' , tint: 'arc', label: 'arc',      name: 'Arc Coil',       desc: 'Lightning chaining between enemies', curve: 'lin', base: 1650, step: 205, add: 440, fmt: 'flat' },
  drones:      { tab: 'offense' , tint: 'wing', label: 'wingmen',  name: 'Escort Wingmen', desc: 'Wingmen firing alongside you',     base: 900,  growth: 1.55,  add: 1,   fmt: 'int', cap: 6, maxLevel: 6 },

  maxHull:      { tab: 'defense', label: 'hull', name: 'Hull Plating',    desc: 'Maximum hull',               curve: 'lin', base: 30,    step: 13,   add: 105,   fmt: 'flat' },
  regen:       { tab: 'defense', label: 'regen', name: 'Nanorepair',      desc: 'Hull regenerated per sec',   base: 65,   growth: 1.15,  add: 3.2,   fmt: 'rate' },
  // One card, not two. Deflector and Capacitor were both strictly dominated by
  // Hull Plating: 0.22 HP per coin on an exponential curve against hull's 1.19
  // on a linear one, 5.4x worse and widening. Merged and put on a linear curve
  // so the shield is a real alternative — a smaller pool that comes back on its
  // own — instead of two cards nobody should ever buy.
  shieldMax:   { tab: 'defense', label: 'shield', name: 'Deflector',       desc: 'Shield capacity, recharges',  curve: 'lin', base: 68, step: 30, add: 44, addRegen: 1.1, fmt: 'flat' },
  armor:       { tab: 'defense', label: 'armor', name: 'Ablative Mesh',   desc: 'Incoming damage reduction',  base: 220,  growth: 1.19,  add: 0.011, fmt: 'pct', cap: 0.70, maxLevel: 64 },
  thorns:      { tab: 'defense', label: 'thorns', name: 'Reactive Spikes', desc: 'Damage reflected on contact',base: 160,  growth: 1.17,  add: 0.22,  fmt: 'mult' },

  coinBonus:   { tab: 'utility', label: 'coins', name: 'Salvage Rig',     desc: 'Coins from every source',    base: 150,  growth: 1.20,  add: 0.075, fmt: 'pctBonus' },
  magnet:      { tab: 'utility', label: 'magnet', name: 'Tractor Field',   desc: 'Pickup collection radius',   base: 150,  growth: 1.19,  add: 11,    fmt: 'flat', maxLevel: 34 },
  // Interest turns hoarding into a real option: spend now for power now, or
  // sit on a balance and compound it. Exponential cost and a hard rate cap on
  // purpose — the payout already compounds, and a linear curve on top of that
  // would make banking the only move worth making.
  interest:    { tab: 'utility', label: 'interest', name: 'Yield Bonds',    desc: 'Interest on banked coins each phase', base: 900,  growth: 1.215, add: 0.005, fmt: 'pct', cap: 0.18, maxLevel: 36 },
  lifesteal:   { tab: 'utility', label: 'siphon', name: 'Siphon Core',     desc: 'Hull restored per kill',     base: 260,  growth: 1.185, add: 0.9,   fmt: 'flat' },
};

// Two cost curves, and the choice between them is the game's whole build layer.
//
// EXPONENTIAL cost against an additive effect makes value-per-coin decay
// exponentially, so the optimum is always "buy whatever is cheapest per point
// right now" — which round-robins across the entire tree. Spreading is not a
// strategy the player picks, it is forced, and every run ends up identical.
//
// LINEAR cost decays value only as ~1/n, so a strong upgrade stays strong and
// deep investment is viable. Paired with a high entry price, that turns the
// question from "what is cheapest" into "which two things am I building this
// run around". Stats on this curve grow with sqrt(coins) rather than log(coins),
// which is a large power increase — hence the higher unit prices and the
// steeper enemy curve that go with it.
//
// Force multipliers stay exponential on purpose: crit, multishot and pierce
// multiply everything else, and letting those scale with sqrt(coins) would
// dwarf every other decision.

/** Cost of buying the NEXT level of an upgrade currently at `level`. */
export function upgradeCost(key, level) {
  const u = UPGRADES[key];
  if (u.curve === 'lin') return Math.ceil(u.base + u.step * level);
  return Math.ceil(u.base * Math.pow(u.growth, level));
}

/** Total cost of buying `n` levels starting from `level`. */
export function upgradeBulkCost(key, level, n) {
  const u = UPGRADES[key];
  if (u.curve === 'lin') {
    // Arithmetic series: n terms starting at base + step*level.
    return Math.ceil(n * (u.base + u.step * level) + u.step * (n * (n - 1)) / 2);
  }
  const r = u.growth;
  return Math.ceil(u.base * Math.pow(r, level) * (Math.pow(r, n) - 1) / (r - 1));
}

/** How many levels of `key` are affordable with `coins`, capped by `max`. */
export function affordableLevels(key, level, coins, max = 1e9) {
  const u = UPGRADES[key];
  const headroom = upgradeMaxLevel(key) - level;
  if (headroom <= 0) return 0;
  if (coins < upgradeCost(key, level)) return 0;

  let n;
  if (u.curve === 'lin') {
    // Invert the arithmetic series: solve (step/2)k^2 + Bk - coins = 0.
    const B = u.base + u.step * level - u.step / 2;
    n = Math.floor((-B + Math.sqrt(B * B + 2 * u.step * coins)) / u.step);
  } else {
    const r = u.growth;
    const c0 = u.base * Math.pow(r, level);
    // Invert the geometric series: n = log_r(1 + coins*(r-1)/c0)
    n = Math.floor(Math.log(1 + (coins * (r - 1)) / c0) / Math.log(r));
  }
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
  labDamage:    { name: 'Fusion Theory', label: 'damage',    desc: 'Bastion damage',              base: 3,  growth: 1.16, mul: 1.09 },
  labFireRate:  { name: 'Chrono Tuning', label: 'fire rate',    desc: 'Bastion fire rate',           base: 4,  growth: 1.17, mul: 1.07 },
  labHull:      { name: 'Alloy Science', label: 'hull',    desc: 'Bastion hull & shields',      base: 3,  growth: 1.16, mul: 1.10 },
  labCoins:     { name: 'Market Analysis', label: 'coins',  desc: 'Coin income',                 base: 5,  growth: 1.18, mul: 1.08 },
  labCrit:      { name: 'Neural Targeting', label: 'crit dmg', desc: 'Critical damage',             base: 9,  growth: 1.19, mul: 1.06 },
  // mul was 2.10 against a cost growth of 1.22 — a ratio of 1.72, meaning every
  // level was 72% MORE cost-effective than the last. Ten levels bought 367K
  // starting coins for 29 cores and skipped the entire early game. Every other
  // track sits between 0.86 and 0.98; this now matches them.
  labStartCash: { name: 'Requisition', label: 'start coins',      desc: 'Coins at run start',          base: 4,  growth: 1.22, mul: 1.17, flatBase: 260 },
  // Run length grows with depth (a wave's spawn window widens with log(wave)),
  // so without this a late run would be a two-hour sit. Buying time compression
  // is the standard idle-game answer and it is strictly quality-of-life, so it
  // is priced low and deliberately does not touch any reward.
  labSpeed:     { name: 'Temporal Rig', label: 'max speed',     desc: 'Maximum simulation speed',    base: 40, growth: 3.20, add: 1, maxLevel: 3 },
  labCoreYield: { name: 'Core Extraction', label: 'cores',  desc: 'Cores earned per run',        base: 30, growth: 1.30, mul: 1.12 },
  // Weapon research is LINEAR cost with an ADDITIVE bonus, so Cores can be
  // poured into one system and specialise a permanent build. It is additive
  // rather than compounding for the same reason the cost is linear: a
  // multiplicative bonus reached via sqrt(cores) levels would grow as
  // exp(sqrt(cores)) and outrun the entire prestige curve within a few runs.
  labLaser:     { name: 'Beam Focusing',  label: 'laser',    desc: 'Pulse Laser damage',          curve: 'lin', base: 30, step: 9,  add: 0.22 },
  labMissile:   { name: 'Warhead Design', label: 'missile',  desc: 'Seeker Pod damage',           curve: 'lin', base: 32, step: 10, add: 0.22 },
  labFlak:      { name: 'Shrapnel Load',  label: 'flak',     desc: 'Flak damage and burst radius',curve: 'lin', base: 36, step: 11, add: 0.20 },
  labArc:       { name: 'Conduction',     label: 'arc',      desc: 'Arc damage, +1 jump per 3 lv',curve: 'lin', base: 40, step: 12, add: 0.20 },
  labWing:      { name: 'Wing Command',   label: 'wingmen',  desc: 'Wingman rate of fire',        curve: 'lin', base: 34, step: 10, add: 0.18 },
  labInterest:  { name: 'Compound Theory', label: 'interest', desc: 'Interest rate on banked coins', base: 26, growth: 1.235, mul: 1.10 },
  labOffline:   { name: 'Autopilot', label: 'offline',        desc: 'Offline coin generation',     base: 25, growth: 1.28, mul: 1.25 },
};

export function labCost(key, level) {
  const l = LAB[key];
  if (l.curve === 'lin') return Math.ceil(l.base + l.step * level);
  return Math.ceil(l.base * Math.pow(l.growth, level));
}

export function labBulkCost(key, level, n) {
  const l = LAB[key];
  if (l.curve === 'lin') {
    return Math.ceil(n * (l.base + l.step * level) + l.step * (n * (n - 1)) / 2);
  }
  const r = l.growth;
  return Math.ceil(l.base * Math.pow(r, level) * (Math.pow(r, n) - 1) / (r - 1));
}

/**
 * Bonus multiplier from a lab track.
 *
 * The core tracks (damage, hull, fire rate, coins, crit) COMPOUND and must stay
 * on an exponential cost curve. That pairing is not a style choice — it is the
 * relationship that keeps infinite prestige working:
 *
 *     ln(CORE_BASE) ~= ln(HP_BASE) * ln(labCostGrowth) / ln(labMultiplier)
 *
 * Enemy health is exponential in the wave, so meta power has to be exponential
 * in the number of prestiges or gains decay to zero. Putting those tracks on a
 * linear cost would make levels grow with sqrt(cores) and the multiplier grow
 * as exp(sqrt(cores)), which outruns the curve entirely within a few runs.
 * The weapon tracks are additive, so they are safe to buy linearly.
 */
export function labMult(key, level) {
  const l = LAB[key];
  const lv = level || 0;
  if (l.add != null && l.mul == null) return 1 + l.add * lv;
  return Math.pow(l.mul, lv);
}

/** Coins granted at the start of a run by Requisition. */
export function startingCoins(level) {
  if (!level) return 0;
  return LAB.labStartCash.flatBase * (Math.pow(LAB.labStartCash.mul, level) - 1);
}

/**
 * Every run starts at the beginning.
 *
 * Forward Deploy used to skip levels, and it never worked: skipping the early
 * levels also skips their income and their upgrade ramp, so it was either a
 * trap or needed a pile of compensating catch-up coins to be survivable — at
 * which point it was just a slower way to be handed resources. Difficulty tiers
 * do the job it was reaching for, properly.
 */
export function startingWave() {
  return 1;
}

/** Speed steps the player may select, widened by Temporal Rig. */
export function speedOptions(labSpeedLevel = 0) {
  return [1, 2, 3, 4].slice(0, 2 + Math.min(2, labSpeedLevel || 0));
}

// Fire intervals for the auto-firing weapon systems. Kept here rather than in
// game.js so deriveStats can fold each system's contribution into `dps` — the
// buying AI in both harnesses ranks upgrades by DPS-per-coin, and a weapon whose
// output is invisible to that calculation would simply never get bought.
export const SYSTEM = { missileCd: 2.5, flakCd: 3.1, arcCd: 1.7, wingFraction: 0.34 };

// ---------------------------------------------------------------------------
// Weapon mastery tiers
// ---------------------------------------------------------------------------
// Linear costs alone do not make specialising worthwhile, because system damage
// grows with sqrt(spend) and the systems ADD together: splitting a budget four
// ways yields 4*sqrt(C/4) = 2*sqrt(C), which beats 1*sqrt(C) for concentrating.
// Measured at a 900K budget, spreading scored 99.5K DPS and all-in laser only
// 67.6K — the arithmetic actively punished commitment.
//
// Breakpoints fix that by making depth superlinear. Crossing one is also a
// visible change in how the weapon behaves, which is the point: a laser build
// and a missile build should look like different games against the same wave.
export const MASTERY = [
  { at: 0,  mult: 1.0 },
  { at: 12, mult: 1.7 },
  { at: 28, mult: 2.9 },
  { at: 50, mult: 4.6 },
];

export function masteryTier(level) {
  let t = 0;
  for (let i = 1; i < MASTERY.length; i++) if (level >= MASTERY[i].at) t = i;
  return t;
}
export const masteryMult = (level) => MASTERY[masteryTier(level)].mult;

/** What each tier actually does, for the upgrade card and the tooltip. */
export const MASTERY_TEXT = {
  laser:    ['single beam', 'beam pierces 2', 'beam pierces 4, wider', 'sweeping cutting beam'],
  missiles: ['single warheads', 'warheads split on impact', 'cluster munitions', 'saturation salvo'],
  flak:     ['single airburst', 'double burst', 'triple burst, wider', 'carpet barrage'],
  arc:      ['chains between targets', 'chains stun briefly', 'forks into two chains', 'permanent tether'],
};

export function masteryLabel(key, level) {
  const t = masteryTier(level);
  const txt = MASTERY_TEXT[key];
  return txt ? { tier: t, text: txt[t] } : null;
}

/**
 * Weapon an elite carries. The pool widens with depth, so late elites bring the
 * genuinely nasty ordnance rather than the same starter volley forever. An
 * elite of an already-armed archetype usually keeps its own gun.
 */
export function eliteWeapon(wave, own) {
  const pool = ['burst'];
  if (wave >= 38) pool.push('spread');
  if (wave >= 58) pool.push('homing');
  if (wave >= 82) pool.push('radial');
  if (wave >= 110) pool.push('beam');
  if (own) { pool.push(own, own); }
  return pool[(Math.random() * pool.length) | 0];
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
export const TUNING = {
  CORE_BASE: 1.016,
  CORE_SCALE: 0.42,
  // Ramming is the swarm's primary attack, so a single bump has to chip rather
  // than cripple. enemyDamage() is sized for a stationary tower that took a
  // handful of hits per wave; a moving ship gets bumped constantly, and at full
  // value nine contacts ended a run. Scaled here rather than in enemyDamage()
  // because sentinel fire and debris still use the unscaled figure.
  CONTACT_SCALE: 1.10,
  // Global multiplier on all enemy ordnance. Weapon damage is expressed
  // relative to an enemy's CONTACT damage, but a projectile connects far more
  // often than a ram does against a dodging autopilot — at parity, three elite
  // volleys ended a run. This is the single knob for how hard the swarm shoots.
  WEAPON_SCALE: 0.25,
  // No single impact may take more than this share of maximum hull.
  //
  // Enemy damage grows exponentially with wave; hull upgrades grow linearly, so
  // by the mid game one ram was ~40% of a full bar and three in a second could
  // delete a healthy ship with no warning. Capping per-hit damage converts that
  // burst lethality into sustained pressure — you always get at least
  // 1 / MAX_HIT_FRACTION impacts, which is what makes hull investment readable
  // as "seconds of survival" rather than an abstract number.
  MAX_HIT_FRACTION: 0.11,
  // Grace period after a heavy hit, so a cluster arriving in the same frame
  // cannot stack several capped hits into an instant kill.
  IFRAME_SECONDS: 0.32,
};

/** Cores awarded for a run that reached `maxWave`. */
export function coresForRun(maxWave, coreYieldLevel = 0, diffIndex = 0) {
  if (maxWave < 5) return 0;
  const yieldMult = labMult('labCoreYield', coreYieldLevel);
  return Math.floor(
    TUNING.CORE_SCALE * Math.pow(TUNING.CORE_BASE, maxWave) * Math.pow(maxWave, 0.9) *
    yieldMult * difficulty(diffIndex).cores
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

  // Per-system permanent research. Each weapon has its own Lab track, so a
  // player can specialise a build rather than every Core going into raw damage.
  const mLaser   = masteryMult(lv('laser'));
  const mMissile = masteryMult(lv('missiles'));
  const mFlak    = masteryMult(lv('flak'));
  const mArc     = masteryMult(lv('arc'));

  const wLaser   = labMult('labLaser',   lab.labLaser);
  const wMissile = labMult('labMissile', lab.labMissile);
  const wFlak    = labMult('labFlak',    lab.labFlak);
  const wArc     = labMult('labArc',     lab.labArc);
  const wWing    = labMult('labWing',    lab.labWing);

  const critChance = Math.min(U.critChance.cap, 0.03 + U.critChance.add * lv('critChance'));
  const critMult   = (1.6 + U.critMult.add * lv('critMult')) * critLab;

  const damage   = (12 + U.damage.add * lv('damage')) * dmgMult;
  const fireRate = (1.6 + U.fireRate.add * lv('fireRate')) * rateMult;
  const shots    = 1 + Math.min(U.multishot.cap, lv('multishot'));
  // Rail Coil removed: a shot passing through a line of enemies fired every
  // hit response at once — flash, sparks, knockback, damage numbers — on
  // targets the player had not aimed at, and made it impossible to read which
  // impact belonged to which shot. Rounds now always stop on their first hit.
  const pierce   = 1;

  // Effective single-target DPS, used by the simulator and the HUD readout.
  const critFactor = 1 + critChance * (critMult - 1);
  const mainDps = damage * fireRate * shots * critFactor;

  // Every auto-firing system folded in, so `dps` means total output. Wingmen
  // fire real guns at a fraction of the ship's rate; the rest are on timers.
  const wingCount = Math.min(U.drones.cap, lv('drones'));
  const wingDps = wingCount * damage * fireRate * SYSTEM.wingFraction * wWing * critFactor;
  const laserDps = U.laser.add * lv('laser') * dmgMult * wLaser * mLaser;
  const missileLv = lv('missiles');
  const missileDps = missileLv
    ? ((150 + U.missiles.add * missileLv) * dmgMult * wMissile * mMissile *
        Math.min(6, 1 + Math.floor(missileLv / 4))) / SYSTEM.missileCd
    : 0;
  const flakDps = (U.flak.add * lv('flak') * dmgMult * wFlak * mFlak *
    [1, 2, 3, 5][masteryTier(lv('flak'))]) / SYSTEM.flakCd;
  // Arc hits several targets; count two for single-target-equivalent purposes.
  const arcDps = (U.arc.add * lv('arc') * dmgMult * wArc * mArc * 2) / SYSTEM.arcCd;
  const dps = mainDps + wingDps + laserDps + missileDps + flakDps + arcDps;

  return {
    damage, fireRate, shots, pierce, critChance, critMult, dps,
    // Fixed. As an upgrade this was dead weight: bullets cross the lane anyway,
    // so paying for reach only changed which enemy the guns happened to track.
    range:       460,
    maxHull:     (300 + U.maxHull.add * lv('maxHull')) * hullMult,
    regen:       (1.5 + U.regen.add * lv('regen')) * hullMult,
    maxShield:   (0 + U.shieldMax.add * lv('shieldMax')) * hullMult,
    shieldRegen: (2 + U.shieldMax.addRegen * lv('shieldMax')) * hullMult,
    armor:       Math.min(U.armor.cap, U.armor.add * lv('armor')),
    thorns:      U.thorns.add * lv('thorns'),
    // --- weapon systems -------------------------------------------------
    laserDps:     U.laser.add * lv('laser') * dmgMult * wLaser * mLaser,
    laserTier:    masteryTier(lv('laser')),
    laserPierce:  [1, 2, 4, 8][masteryTier(lv('laser'))],
    missileDmg:   lv('missiles') ? (150 + U.missiles.add * lv('missiles')) * dmgMult * wMissile * mMissile : 0,
    missileCount: Math.min(6, 1 + Math.floor(lv('missiles') / 4)),
    missileTier:  masteryTier(lv('missiles')),
    flakDmg:      U.flak.add * lv('flak') * dmgMult * wFlak * mFlak,
    flakRadius:   (72 + lv('flak') * 2.4) * Math.pow(wFlak, 0.35) * (1 + masteryTier(lv('flak')) * 0.12),
    flakTier:     masteryTier(lv('flak')),
    flakBursts:   [1, 2, 3, 5][masteryTier(lv('flak'))],
    arcDmg:       U.arc.add * lv('arc') * dmgMult * wArc * mArc,
    arcJumps:     Math.min(12, 2 + Math.floor(lv('arc') / 4) + Math.floor((lab.labArc || 0) / 3)),
    arcTier:      masteryTier(lv('arc')),
    arcForks:     masteryTier(lv('arc')) >= 2 ? 2 : 1,
    wingRate:     SYSTEM.wingFraction * wWing,

    coinMult:    coinMult * (1 + U.coinBonus.add * lv('coinBonus')),
    interest:    Math.min(0.24, U.interest.add * lv('interest') * labMult('labInterest', lab.labInterest)),
    // Pickups have to be flown over to be collected, so magnet radius is a
    // real economy stat, not a convenience: without it, loot drifts off-screen.
    magnet:      92 + U.magnet.add * lv('magnet'),
    // Multiplier on the autopilot's top speed and threat-reaction distance.
    evasion:     1.35,
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
