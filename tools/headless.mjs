// Headless smoke test for the REAL game loop.
//
//   node tools/headless.mjs [--waves 40] [--verbose]
//
// tools/simulate.mjs models the balance abstractly; this file is different — it
// imports js/game/game.js itself and drives Game.update() at a fixed timestep,
// so it catches the things a balance model cannot: entities that never spawn,
// waves that never complete, NaN leaking into stats, pools that exhaust, coins
// that stop accruing. Run it after touching anything in js/game/.
//
// Exits non-zero on failure so it can gate a commit.

import { Game } from '../js/game/game.js';
import { GameState } from '../js/game/state.js';
import { fmt, UPGRADES, upgradeCost, upgradeMaxLevel } from '../js/game/balance.js';

const args = process.argv.slice(2);
const argOf = (f, d) => { const i = args.indexOf(f); return i >= 0 ? Number(args[i + 1]) : d; };
const TARGET_WAVES = argOf('--waves', 40);
const VERBOSE = args.includes('--verbose');
// --natural disables the keep-alive so we can measure how deep a competent
// player actually gets. The autopilot dodges, so survivability is now an
// emergent property of the steering code and cannot be assumed from balance.js.
const NATURAL = args.includes('--natural');
const DT = 1 / 60;
const MAX_SIM_SECONDS = 20000;

// --- stubs ---------------------------------------------------------------------

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const silentSynth = new Proxy({}, { get: () => () => {} });

// Records draw calls so we can assert the renderer is actually being fed.
const stubRenderer = {
  flash: [0, 0, 0], calls: 0,
  begin() { this.calls = 0; },
  push() { this.calls++; },
  glow() { this.calls++; }, disc() { this.calls++; }, ring() { this.calls++; },
  poly() { this.calls++; }, beam() { this.calls++; }, spark() { this.calls++; },
  polyLit() { this.calls++; }, discLit() { this.calls++; },
  slabLit() { this.calls++; }, beamLit() { this.calls++; },
  flush() {},
};

// --- run ---------------------------------------------------------------------

const state = new GameState();
const overlayErrors = [];
// A strict 2D-context stub. A real canvas silently ignores undefined/NaN
// coordinates, which is exactly how a dangling variable in renderOverlay
// reached production and froze the game on the first damage number.
const ctx2d = new Proxy({}, {
  get(_t, k) {
    if (k === 'canvas') return { width: 420, height: 780 };
    // Query methods have to hand back something usable or the overlay cannot run.
    if (k === 'measureText') return (t) => ({ width: String(t).length * 7 });
    if (k === 'createLinearGradient' || k === 'createRadialGradient') {
      return () => ({ addColorStop() {} });
    }
    return (...args) => {
      for (const [i, a] of args.entries()) {
        if (a === undefined || (typeof a === 'number' && !Number.isFinite(a))) {
          overlayErrors.push(`ctx.${String(k)}() arg ${i} is ${a}`);
        }
      }
    };
  },
  set() { return true; },
});

const game = new Game(state, silentSynth, stubRenderer);
game.resize(420, 780);   // phone-ish portrait, the primary target

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

/**
 * Buys whichever upgrade gives the most power per coin, where power blends
 * offence and survivability. Mirrors the policy in tools/simulate.mjs so the
 * two harnesses agree about what a competent player does.
 */
function powerOf() {
  const s = game.stats;
  const ehp = (s.maxHull + s.maxShield) / (1 - s.armor);
  return Math.pow(s.dps, 0.62) * Math.pow(ehp, 0.38) * (1 + s.coinMult * 0.05);
}

function autoBuy() {
  let bought = 0;
  for (;;) {
    const base = powerOf();
    let best = null;
    for (const key of Object.keys(UPGRADES)) {
      const lvl = state.run.upgrades[key] || 0;
      if (lvl >= upgradeMaxLevel(key)) continue;
      const cost = upgradeCost(key, lvl);
      if (cost > state.run.coins) continue;
      state.run.upgrades[key] = lvl + 1;
      game.markStatsDirty();
      const value = (powerOf() / base - 1) / cost;
      state.run.upgrades[key] = lvl;
      game.markStatsDirty();
      if (!best || value > best.value) best = { key, cost, lvl, value };
    }
    if (!best || bought > 400) return bought;
    state.run.coins -= best.cost;
    state.run.upgrades[best.key] = best.lvl + 1;
    game.markStatsDirty();
    // Mirror UI.buy(): raising the cap also repairs, or the ship sits at a
    // fraction of its new maximum and dies to the first thing it meets.
    if (best.key === 'maxHull') {
      state.run.hull = Math.min(game.stats.maxHull, state.run.hull + UPGRADES.maxHull.add);
    }
    bought++;
  }
}

let simTime = 0;
let lastWave = state.run.wave;
let waveStartTime = 0;
const waveDurations = [];
let peakEnemies = 0, peakBullets = 0, peakParticles = 0, peakPickups = 0;
// Wreckage must actually spawn AND land. A pool that only ever grows means
// pieces are leaking; one that never fires impacts means they scroll away
// before touching down, and the terrain layer stays scenery.
let peakWrecks = 0, wreckPoolGrowth = 0;
const wreckStartSize = game.wrecks.items.length;
let impacts = 0;
const realImpact = game.wreckImpact.bind(game);
game.wreckImpact = (w) => { impacts++; realImpact(w); };
let totalBought = 0, revives = 0;
let collected = 0, lastCoins = state.run.coins;

totalBought += autoBuy();   // spend starting coins before wave one
console.log('\n  VOID BASTION — headless loop test');
console.log(`  driving the real Game.update() at ${Math.round(1 / DT)}Hz\n`);
if (VERBOSE) console.log('  wave   dur    kills    coins       hull      alive');

let renderFrames = 0;
while (state.run.wave < TARGET_WAVES && simTime < MAX_SIM_SECONDS && !state.run.over) {
  game.update(DT);
  simTime += DT;

  // Every 7th frame: often enough that a 0.9s floater, a falling wreck and a
  // hitstop hold are all on screen at some point, cheap enough not to dominate.
  if (renderFrames++ % 7 === 0) {
    game.render(simTime);
    game.renderOverlay(ctx2d, 1);
  }

  if (state.run.coins > lastCoins) collected += state.run.coins - lastCoins;
  lastCoins = state.run.coins;

  const alive = game.enemies.items.filter((e) => e.active).length;
  peakEnemies = Math.max(peakEnemies, alive);
  peakBullets = Math.max(peakBullets, game.bullets.items.filter((b) => b.active).length);
  peakParticles = Math.max(peakParticles, game.particles.items.filter((p) => p.active).length);
  peakWrecks = Math.max(peakWrecks, game.wrecks.items.filter((w) => w.active).length);
  wreckPoolGrowth = game.wrecks.items.length - wreckStartSize;
  peakPickups = Math.max(peakPickups, game.pickups.items.filter((p) => p.active).length);

  if (state.run.wave !== lastWave) {
    const dur = simTime - waveStartTime;
    waveDurations.push(dur);
    if (VERBOSE) {
      console.log(
        `  ${String(lastWave).padStart(4)}  ${dur.toFixed(1).padStart(5)}s  ` +
        `${String(state.run.kills).padStart(6)}  ${fmt(state.run.coins).padStart(9)}  ` +
        `${fmt(Math.max(0, state.run.hull)).padStart(9)}  ${String(alive).padStart(5)}`
      );
    }
    check(dur < 300, `wave ${lastWave} took ${dur.toFixed(0)}s — likely stalled`);
    totalBought += autoBuy();
    lastWave = state.run.wave;
    waveStartTime = simTime;
  }

  // Keep the bastion standing so the test always reaches the target wave. We are
  // exercising the machinery here; whether a real player survives is what
  // tools/simulate.mjs answers.
  if (!NATURAL) {
    if (state.run.over) { state.run.over = false; revives++; }
    state.run.hull = game.stats.maxHull;
    lastCoins = state.run.coins;
  }
}

// --- render pass ---------------------------------------------------------------

stubRenderer.calls = 0;
game.render(simTime);
game.renderOverlay(ctx2d, 1);
const drawCalls = stubRenderer.calls;
const renderedFrames = Math.floor(renderFrames / 7);

// --- assertions ----------------------------------------------------------------

const s = game.stats;
if (!NATURAL) check(state.run.wave >= TARGET_WAVES, `only reached wave ${state.run.wave} of ${TARGET_WAVES}`);
check(state.run.kills > 0, 'no enemies were ever killed');
check(totalBought > 0, 'no upgrade was ever purchasable');
check(state.run.coins > 0, 'no coins were ever earned');
check(peakEnemies > 0, 'no enemy was ever spawned');
check(peakBullets > 0, 'the bastion never fired');
check(peakParticles > 0, 'no particles were ever emitted');
check(peakWrecks > 0, 'no craft ever shed wreckage');
check(impacts > 0, 'wreckage never reached a surface — nothing splashes or scorches');
check(wreckPoolGrowth === 0,
  `wreck pool grew by ${wreckPoolGrowth} past its ${wreckStartSize} slots — pieces are leaking`);
check(peakPickups > 0, 'kills never dropped any loot');
check(collected > 0, 'the ship never collected a single pickup');
check(drawCalls > 50, `render() only issued ${drawCalls} draw calls`);
check(overlayErrors.length === 0,
  `overlay drew with bad arguments: ${[...new Set(overlayErrors)].slice(0, 4).join('; ')}`);
check(renderedFrames > 100, `only ${renderedFrames} frames were ever rendered`);
for (const [k, v] of Object.entries(s)) {
  check(Number.isFinite(v), `stat "${k}" is not finite (${v})`);
}
check(Number.isFinite(state.run.coins), 'coins went non-finite');
check(simTime < MAX_SIM_SECONDS, 'hit the simulated-time ceiling');

const avgWave = waveDurations.reduce((a, b) => a + b, 0) / Math.max(1, waveDurations.length);
check(avgWave > 2, `average wave lasted only ${avgWave.toFixed(1)}s — waves are not really running`);

// --- report ---------------------------------------------------------------------

console.log(`
  reached wave ......... ${state.run.wave}
  sim time ............. ${(simTime / 60).toFixed(1)} min
  avg wave duration .... ${avgWave.toFixed(1)}s
  kills ................ ${state.run.kills}
  coins ................ ${fmt(state.run.coins)}
  peak alive enemies ... ${peakEnemies}
  peak bullets ......... ${peakBullets}
  peak particles ....... ${peakParticles}
  peak wrecks .......... ${peakWrecks} of ${game.wrecks.items.length} slots
  wreck impacts ........ ${impacts}
  peak pickups ......... ${peakPickups}
  coins collected ...... ${fmt(collected)}
  upgrades bought ...... ${totalBought}
  revives (deaths) ..... ${revives}${NATURAL ? '  (natural mode: died for real)' : ''}
  pool sizes ........... enemies ${game.enemies.items.length}, bullets ${game.bullets.items.length}, particles ${game.particles.items.length}
  draw calls / frame ... ${drawCalls}
  frames rendered ...... ${renderedFrames}
  overlay arg errors ... ${overlayErrors.length}
`);

if (failures.length) {
  console.log('  FAILED:');
  for (const f of failures) console.log('    ✗ ' + f);
  console.log('');
  process.exit(1);
}
console.log('  ✓ all checks passed\n');
