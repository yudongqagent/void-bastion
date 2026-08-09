// Balance harness for VOID BASTION.
//
//   node tools/simulate.mjs            # 12 prestige runs, summary table
//   node tools/simulate.mjs --runs 40  # longer horizon
//   node tools/simulate.mjs --trace 3  # wave-by-wave detail for run 3
//
// This plays the game headlessly against js/game/balance.js using a greedy
// "reasonably competent player" buying policy, then reports how deep each run
// gets. What we are looking for in the output:
//
//   * run 1 ends somewhere around wave 20-45 (long enough to learn the game,
//     short enough that the first prestige arrives quickly)
//   * every run reaches a deeper wave than the last, with no plateau
//   * the wave gain per run shrinks slowly rather than stopping dead
//   * no run ends on wave 1-3 (that would mean prestige made you weaker)

import {
  enemyHP, enemyCount, enemySpeed, enemyDamage, coinValue, waveClearBonus,
  isBossWave, bossStats, spawnTable, spawnWindow, UPGRADES, upgradeCost, upgradeMaxLevel,
  LAB, labCost, startingCoins, startingWave, coresForRun, deriveStats, fmt, TUNING,
} from '../js/game/balance.js';

const args = process.argv.slice(2);
const argOf = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const RUNS = argOf('--runs', 12);
const TRACE = argOf('--trace', 0);
// Safety net: if a run gets this deep the balance is broken (or the player is
// unkillable), and we want the harness to say so rather than hang.
const MAX_WAVE = argOf('--maxwave', 1200);
if (args.includes('--corebase')) TUNING.CORE_BASE = argOf('--corebase', TUNING.CORE_BASE);

const SPAWN_RADIUS = 430;   // matches the renderer's play field
const TOWER_RADIUS = 30;
const DT = 0.05;
const WAVE_TIMEOUT = 240;   // seconds before we call a wave a stall

// --- deterministic RNG so runs are reproducible between tunings -------------
let seed = 12345;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

// --- greedy purchasing policy ----------------------------------------------
// Scores each upgrade by marginal power gained per coin, where "power" blends
// offence and survivability. A real player is worse than this; that is fine,
// we are checking the curve has a viable path, not that it is the only path.

function powerScore(up, lab, prestige) {
  const s = deriveStats(up, lab, prestige);
  const ehp = (s.maxHull + s.maxShield) / (1 - s.armor);
  // Geometric blend keeps the policy from dumping everything into one axis.
  return Math.pow(s.dps, 0.62) * Math.pow(ehp, 0.38) * (1 + s.coinMult * 0.05);
}

function bestPurchase(up, lab, prestige, coins) {
  const basePower = powerScore(up, lab, prestige);
  let best = null;
  for (const key of Object.keys(UPGRADES)) {
    const u = UPGRADES[key];
    const lvl = up[key] || 0;
    if (lvl + 1 > upgradeMaxLevel(key)) continue;
    const cost = upgradeCost(key, lvl);
    if (cost > coins) continue;
    up[key] = lvl + 1;
    const gain = powerScore(up, lab, prestige) / basePower - 1;
    up[key] = lvl;
    const value = gain / cost;
    if (!best || value > best.value) best = { key, cost, value };
  }
  return best;
}

function spend(up, lab, prestige, state) {
  let bought = 0;
  while (bought < 400) {
    const buy = bestPurchase(up, lab, prestige, state.coins);
    if (!buy) break;
    state.coins -= buy.cost;
    up[buy.key] = (up[buy.key] || 0) + 1;
    bought++;
  }
}

// --- one wave ---------------------------------------------------------------

function simulateWave(wave, up, lab, prestige, state) {
  const stats = deriveStats(up, lab, prestige);
  const table = spawnTable(wave);
  const totalWeight = table.reduce((a, t) => a + t.weight, 0);
  const count = enemyCount(wave);
  const baseHP = enemyHP(wave);
  const baseSpeed = enemySpeed(wave);
  const baseDmg = enemyDamage(wave);

  const queue = [];
  for (let i = 0; i < count; i++) {
    let r = rnd() * totalWeight, pick = table[0];
    for (const t of table) { r -= t.weight; if (r <= 0) { pick = t; break; } }
    const a = pick.arch;
    queue.push({
      hp: baseHP * a.hp,
      speed: baseSpeed * a.speed,
      dmg: baseDmg * a.dmg,
      coin: coinValue(wave) * a.coin,
      splits: pick.key === 'splitter' ? 2 : 0,
    });
  }
  if (isBossWave(wave)) {
    const b = bossStats(wave);
    queue.push({ hp: b.hp, speed: b.speed, dmg: b.damage, coin: b.coins, splits: 0, boss: true });
  }

  // Spawns are spread across a fixed window rather than a fixed per-enemy gap.
  const spawnInterval = spawnWindow(wave) / queue.length;
  const alive = [];
  let spawnTimer = 0, t = 0, killed = 0;

  while (t < WAVE_TIMEOUT) {
    t += DT;

    spawnTimer -= DT;
    while (queue.length && spawnTimer <= 0) {
      const e = queue.shift();
      e.dist = SPAWN_RADIUS;
      alive.push(e);
      spawnTimer += spawnInterval;
    }

    // Tower fire: DPS is applied to targets inside range, focus-firing but
    // spread across `pierce` enemies at once.
    let budget = stats.dps * DT;
    const inRange = alive.filter((e) => e.dist <= stats.range).sort((a, b) => a.dist - b.dist);
    const targets = inRange.slice(0, Math.max(1, stats.pierce));
    if (targets.length) {
      const per = budget / targets.length;
      for (const e of targets) e.hp -= per;
    }

    // Drones add a flat fraction of tower DPS each, ignoring range.
    if (stats.drones > 0 && alive.length) {
      const droneDps = stats.dps * 0.22 * stats.drones * DT;
      const per = droneDps / Math.min(alive.length, 3);
      for (let i = 0; i < Math.min(alive.length, 3); i++) alive[i].hp -= per;
    }

    for (let i = alive.length - 1; i >= 0; i--) {
      const e = alive[i];
      if (e.hp <= 0) {
        killed++;
        state.coins += e.coin * stats.coinMult;
        state.hull = Math.min(stats.maxHull, state.hull + stats.lifesteal);
        if (e.splits > 0) {
          for (let s = 0; s < e.splits; s++) {
            alive.push({ hp: e.hp0 ? e.hp0 * 0.35 : baseHP * 0.4, speed: e.speed * 1.35, dmg: e.dmg * 0.5, coin: e.coin * 0.3, splits: 0, dist: e.dist });
          }
        }
        alive.splice(i, 1);
        continue;
      }
      e.dist -= e.speed * DT;
      if (e.dist <= TOWER_RADIUS) {
        // Contact: shield soaks first, then hull. Armor reduces both.
        let dmg = e.dmg * (1 - stats.armor);
        const absorbed = Math.min(state.shield, dmg);
        state.shield -= absorbed;
        dmg -= absorbed;
        state.hull -= dmg;
        e.hp -= stats.thorns * e.dmg;
        alive.splice(i, 1);
        if (state.hull <= 0) return { dead: true, t, killed };
      }
    }

    state.hull = Math.min(stats.maxHull, state.hull + stats.regen * DT);
    state.shield = Math.min(stats.maxShield, state.shield + stats.shieldRegen * DT);

    if (!queue.length && !alive.length) {
      state.coins += waveClearBonus(wave) * stats.coinMult;
      return { dead: false, t, killed };
    }
  }
  return { dead: false, t, killed, stalled: true };
}

// --- one full run -----------------------------------------------------------

function simulateRun(lab, prestige, trace) {
  const up = {};
  const startWave = startingWave();
  let stats = deriveStats(up, lab, prestige);
  const state = {
    coins: startingCoins(lab.labStartCash),
    hull: stats.maxHull,
    shield: stats.maxShield,
  };
  spend(up, lab, prestige, state);

  let wave = startWave, elapsed = 0, capped = false;
  for (; wave < MAX_WAVE; wave++) {
    stats = deriveStats(up, lab, prestige);
    state.hull = Math.min(state.hull, stats.maxHull);
    const res = simulateWave(wave, up, lab, prestige, state);
    elapsed += res.t;
    if (trace && (wave % 5 === 0 || res.dead)) {
      const s = deriveStats(up, lab, prestige);
      console.log(
        `    w${String(wave).padStart(4)}  ${String(Math.round(res.t)).padStart(3)}s` +
        `  hull ${fmt(Math.max(0, state.hull)).padStart(7)}/${fmt(s.maxHull).padEnd(7)}` +
        `  dps ${fmt(s.dps).padStart(8)}  ehp/dmg ${(((s.maxHull + s.maxShield) / (1 - s.armor)) / enemyDamage(wave)).toFixed(1).padStart(6)}` +
        `  coins ${fmt(state.coins).padStart(8)}`
      );
    }
    if (res.dead) break;
    if (res.stalled) { if (trace) console.log(`    stalled on wave ${wave}`); break; }
    spend(up, lab, prestige, state);
  }
  if (wave >= MAX_WAVE) capped = true;
  return { maxWave: wave, elapsed, up, capped };
}

// --- lab purchasing between runs -------------------------------------------

function spendCores(lab, cores) {
  // Rough but sane meta policy: prioritise the multipliers that compound,
  // keep Forward Deploy roughly in step with how deep we actually get.
  const order = [
    'labDamage', 'labHull', 'labFireRate', 'labCoins', 'labCrit',
    'labLaser', 'labMissile', 'labFlak', 'labArc', 'labWing',
    'labStartCash', 'labCoreYield', 'labInterest', 'labSpeed', 'labOffline',
  ];
  let spent = true;
  while (spent) {
    spent = false;
    for (const key of order) {
      const lvl = lab[key] || 0;
      if (LAB[key].maxLevel != null && lvl >= LAB[key].maxLevel) continue;
      const cost = labCost(key, lvl);
      if (cost <= cores) { cores -= cost; lab[key] = lvl + 1; spent = true; }
    }
  }
  return cores;
}

// --- a whole player career --------------------------------------------------

function playSession(runs, { verbose = false, trace = 0 } = {}) {
  seed = 12345; // reset RNG so every sweep point sees identical waves
  const lab = {};
  const waves = [], times = [];
  let cores = 0, prestige = 0, prevWave = 0, capped = false;

  for (let r = 1; r <= runs; r++) {
    const doTrace = r === trace;
    if (doTrace) console.log(`\n  --- trace of run ${r} ---`);
    const res = simulateRun(lab, prestige, doTrace);
    const earned = coresForRun(res.maxWave, lab.labCoreYield || 0);
    cores += earned;
    cores = spendCores(lab, cores);
    prestige++;
    waves.push(res.maxWave);
    times.push(res.elapsed);

    if (verbose) {
      const labStr = Object.entries(lab).filter(([, v]) => v > 0)
        .map(([k, v]) => `${k.replace('lab', '')}:${v}`).join(' ');
      const delta = res.maxWave - prevWave;
      console.log(
        `  ${String(r).padStart(3)}  ${String(res.maxWave).padStart(5)}${res.capped ? '!' : ' '} ` +
        `${(delta >= 0 ? '+' : '') + delta}`.padStart(5) + '  ' +
        `${(res.elapsed / 60).toFixed(1)}m`.padStart(7) + '  ' +
        `${fmt(earned)}`.padStart(8) + '   ' + labStr
      );
      if (doTrace) console.log('');
    }
    prevWave = res.maxWave;
    if (res.capped) { capped = true; break; }
  }

  const deltas = waves.slice(1).map((w, i) => w - waves[i]);
  const half = Math.max(1, Math.floor(deltas.length / 2));
  const tail = deltas.slice(-half);
  const head = deltas.slice(0, deltas.length - half);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return {
    waves, times, capped,
    firstRun: waves[0],
    lastRun: waves[waves.length - 1],
    meanDelta: avg(deltas),
    tailDelta: avg(tail),
    // >1 means prestige gains are accelerating (runaway power),
    // <1 means they are decaying toward a plateau (flat grind).
    driftRatio: head.length ? avg(tail) / Math.max(1, avg(head)) : 1,
  };
}

// --- drive ------------------------------------------------------------------

if (args.includes('--sweep')) {
  console.log('\n  CORE_BASE sweep — looking for steady, non-accelerating prestige gains\n');
  console.log('  CORE_BASE   run1   last   meanΔ   tailΔ   drift   verdict');
  console.log('  ' + '-'.repeat(68));
  for (const base of [1.011, 1.013, 1.015, 1.017, 1.019]) {
    TUNING.CORE_BASE = base;
    const s = playSession(RUNS);
    const verdict = s.capped ? 'RUNAWAY (hit ceiling)'
      : s.driftRatio > 1.7 ? 'accelerating'
      : s.driftRatio < 0.55 ? 'plateauing'
      : 'steady';
    console.log(
      `  ${base.toFixed(3).padStart(9)}  ${String(s.firstRun).padStart(5)}  ${String(s.lastRun).padStart(5)}  ` +
      `${s.meanDelta.toFixed(1).padStart(6)}  ${s.tailDelta.toFixed(1).padStart(6)}  ` +
      `${s.driftRatio.toFixed(2).padStart(6)}   ${verdict}`
    );
  }
  console.log('');
} else {
  console.log('\n  VOID BASTION — progression simulation');
  console.log(`  CORE_BASE=${TUNING.CORE_BASE}\n`);
  console.log('  run   wave   Δ      time      cores   lab levels');
  console.log('  ' + '-'.repeat(76));
  const s = playSession(RUNS, { verbose: true, trace: TRACE });
  console.log('  ' + '-'.repeat(76));
  console.log(
    `  first run w${s.firstRun}   mean Δ ${s.meanDelta.toFixed(1)} waves/prestige   ` +
    `tail Δ ${s.tailDelta.toFixed(1)}   drift ${s.driftRatio.toFixed(2)}` +
    (s.capped ? '   !! HIT CEILING' : '')
  );
  console.log(`  run length: ${(s.times[0] / 60).toFixed(1)}m first → ${(s.times[s.times.length - 1] / 60).toFixed(1)}m last\n`);
}
