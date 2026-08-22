// Career harness: plays N prestige runs end to end and reports how deep each
// one got.
//
//   node tools/career.mjs [runs] [--seed=N]
//
// This lived in a scratch directory for most of its life and got wiped between
// sessions, which meant every balance change was measured against a baseline
// that no longer existed. It belongs in the repo.
//
// SEEDED, and that matters more than it looks. Unseeded, identical code
// produced 13, 11 and 14 on three consecutive runs — a spread wider than most
// of the effects being measured. Any conclusion drawn from an unseeded run of
// this thing is noise.
import { Game } from '../js/game/game.js';
import { GameState } from '../js/game/state.js';
import { UPGRADES, LAB, upgradeCost, labCost } from '../js/game/balance.js';
import { freshRun } from '../js/game/state.js';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const RUNS = Number(process.argv[2] || 5);
const SEED = Number((process.argv.find((a) => a.startsWith('--seed=')) || '--seed=7').split('=')[1]);

// xorshift over Math.random, so a run is reproducible.
(function seedRandom(seed) {
  let x = seed >>> 0 || 1;
  Math.random = () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
})(SEED);

const synth = new Proxy({}, { get: () => () => {} });
const R = new Proxy({
  shake: [0, 0], flash: [0, 0, 0], uvOrigin: [0, 0], grade: [1, 1, 1], saturation: 1,
  terrainPal: { sand: [0, 0, 0], grass: [0, 0, 0], scrub: [0, 0, 0], rock: [0, 0, 0], surf: [0, 0, 0] },
}, { get: (t, k) => (k in t ? t[k] : () => {}) });

const state = new GameState();
const game = new Game(state, synth, R);
game.resize(390, 844);

/** Buy the cheapest affordable in-run upgrade, repeatedly. */
function spendCoins() {
  for (let n = 0; n < 60; n++) {
    let best = null, bestCost = Infinity;
    for (const id of Object.keys(UPGRADES)) {
      const c = upgradeCost(id, state.run.upgrades[id] || 0);
      if (c <= state.run.coins && c < bestCost) { best = id; bestCost = c; }
    }
    if (!best) return;
    state.run.coins -= bestCost;
    state.run.upgrades[best] = (state.run.upgrades[best] || 0) + 1;
    game.recomputeStats();
    // UI.buy() heals on a hull purchase; without this the harness sits at low
    // hull all run and dies early for a reason no player would experience.
    if (best === 'maxHull') state.run.hull = game.stats.maxHull;
  }
}

/** Spend cores on the cheapest lab track. */
function spendCores() {
  for (let n = 0; n < 40; n++) {
    let best = null, bestCost = Infinity;
    for (const id of Object.keys(LAB)) {
      const c = labCost(id, state.meta.lab[id] || 0);
      if (c <= state.meta.cores && c < bestCost) { best = id; bestCost = c; }
    }
    if (!best) return;
    state.meta.cores -= bestCost;
    state.meta.lab[best] = (state.meta.lab[best] || 0) + 1;
  }
}

console.log(`\n  career — ${RUNS} runs, seed ${SEED}\n`);
console.log('  run  level  delta   mins   s/lvl     cores  lab');
console.log('  ' + '-'.repeat(74));

let prev = 0;
for (let run = 1; run <= RUNS; run++) {
  spendCores();
  // Mirrors main.js startNewRun(): a fresh run plus a cleared battlefield. The
  // first version of this called methods that do not exist, so runs 2+ simply
  // continued the dead run and reported the same level four times.
  state.run = freshRun(state.meta);
  game.markStatsDirty();
  for (const e of game.enemies.items) e.active = false;
  for (const b of game.bullets.items) b.active = false;
  for (const p of game.particles.items) p.active = false;
  for (const w of game.wrecks.items) w.active = false;
  for (const pk of game.pickups.items) pk.active = false;
  game.spawnQueue.length = 0;
  game.waveActive = false;
  game.interWave = 1.4;
  game.buffs = {};
  game.singularity = null;
  game.lance = null;
  game.floaters.length = 0;
  game.paused = false;
  game.recomputeStats();
  spendCoins();

  let t = 0;
  const LIMIT = 60 * 60 * 90;              // 90 simulated minutes
  let lastWave = state.run.wave;
  for (let i = 0; i < LIMIT && !state.run.over; i++) {
    game.update(1 / 60);
    t += 1 / 60;
    if (state.run.wave !== lastWave) { lastWave = state.run.wave; spendCoins(); }
  }
  const lvl = state.run.wave;
  state.bankRun();
  const labs = Object.entries(state.meta.lab)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => k.replace(/^lab/, '') + ':' + v).join(' ');
  console.log([
    '  ' + String(run).padStart(3),
    String(lvl).padStart(6),
    (lvl - prev >= 0 ? '+' : '') + String(lvl - prev).padStart(4),
    (t / 60).toFixed(0).padStart(6) + 'm',
    (t / Math.max(1, lvl)).toFixed(0).padStart(6) + 's',
    String(Math.round(state.meta.cores)).padStart(9),
    ' ' + labs.slice(0, 90),
  ].join(' '));
  prev = lvl;
}
console.log('');
