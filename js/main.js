// VOID BASTION — entry point. Boots the renderer, wires the loop, translates
// game events into UI reactions.

import { Renderer } from './gl/renderer.js';
import { Game } from './game/game.js';
import { GameState, freshRun } from './game/state.js';
import { Synth } from './audio/synth.js';
import { UI } from './ui/hud.js';
import { coresForRun, fmt } from './game/balance.js';

const sceneCanvas = document.getElementById('scene');
const overlayCanvas = document.getElementById('overlay');
const overlayCtx = overlayCanvas.getContext('2d');

function fatal(message, detail) {
  const el = document.getElementById('bootError');
  el.hidden = false;
  el.innerHTML =
    `<div style="font-size:19px;letter-spacing:.2em">BASTION OFFLINE</div>
     <div>${message}</div>
     <div style="color:#7c96a6;font-size:11px;max-width:34em">${detail || ''}</div>`;
}

let renderer;
try {
  renderer = new Renderer(sceneCanvas);
} catch (err) {
  fatal('This game needs WebGL2.',
    'Try a current version of Chrome, Safari, Firefox or Edge with hardware acceleration enabled. ' +
    String(err && err.message || err));
  throw err;
}

const state = new GameState();
const hadSave = state.load();
const synth = new Synth();
const game = new Game(state, synth, renderer);
const ui = new UI(game, state, synth);

// Exposed deliberately: handy for debugging a live session from the console,
// and there is nothing here worth hiding in a single-player offline game.
window.VB = { game, state, ui, synth, renderer };

// --- sizing -------------------------------------------------------------------

let lastW = 0, lastH = 0, lastDpr = 0;

function resize() {
  // A tab that is still being laid out can report 0 here. Sizing the world to
  // zero puts the enemy spawn ring on top of the bastion and breaks the run, so
  // refuse the update and let the per-frame check pick it up once it is real.
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (w < 2 || h < 2) return false;
  // Cap DPR: a 3x phone display at full res costs ~9x the fill rate for a
  // difference nobody can see through bloom and scanlines.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (w === lastW && h === lastH && dpr === lastDpr) return true;
  lastW = w; lastH = h; lastDpr = dpr;

  renderer.resize(w, h, dpr);
  overlayCanvas.width = Math.floor(w * dpr);
  overlayCanvas.height = Math.floor(h * dpr);
  overlayCanvas.style.width = w + 'px';
  overlayCanvas.style.height = h + 'px';
  game.resize(w, h);
  game.overlayDpr = dpr;
  return true;
}
resize();
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 120));

// --- audio unlock --------------------------------------------------------------

function unlockAudio() {
  synth.init();
  synth.resume();
  synth.setEnabled(state.meta.settings.sound !== false);
  window.removeEventListener('pointerdown', unlockAudio);
  window.removeEventListener('keydown', unlockAudio);
}
window.addEventListener('pointerdown', unlockAudio, { once: false });
window.addEventListener('keydown', unlockAudio, { once: false });

// --- event handling ------------------------------------------------------------

function handleEvents() {
  for (const ev of game.events) {
    switch (ev.type) {
      case 'boss':
        ui.toast(`WAVE ${ev.data.wave} — BOSS INBOUND`, 'danger', true);
        break;
      case 'bossKill':
        ui.toast('BOSS DESTROYED', 'gold');
        break;
      case 'milestone':
        ui.toast(`MILESTONE — WAVE ${ev.data.wave}`, 'gold', true);
        break;
      case 'enrage':
        // The wave has dragged on; survivors are winding up. Tell the player
        // why the swarm just got faster instead of letting it feel like a bug.
        ui.toast('SWARM ENRAGED — FINISH THE WAVE', 'danger', true);
        break;
      case 'runOver':
        ui.showRunOver();
        break;
    }
  }
  game.events.length = 0;
}

// --- run lifecycle ---------------------------------------------------------------

function ascend(fromDeath) {
  const { run, meta } = state;
  const cores = coresForRun(run.wave, meta.lab.labCoreYield || 0);
  meta.cores += cores;
  meta.prestiges++;
  meta.totalRuns++;
  if (run.wave > meta.bestWave) meta.bestWave = run.wave;

  state.run = freshRun(meta);
  game.markStatsDirty();

  // Clear the battlefield so the new run does not inherit the old swarm.
  for (const e of game.enemies.items) e.active = false;
  for (const b of game.bullets.items) b.active = false;
  for (const p of game.particles.items) p.active = false;
  game.spawnQueue.length = 0;
  game.waveActive = false;
  game.interWave = 1.4;
  game.buffs = {};
  game.singularity = null;
  game.lance = null;
  game.floaters.length = 0;
  game.shakeAmount = 0;
  game.flashAmount = 0;
  game.paused = false;

  state.save();
  ui.hideModal();
  ui.buildUpgradeRows();
  ui.buildAbilityBar();
  synth.prestige();
  ui.toast(`ASCENDED — +${fmt(cores)} CORES`, 'violet', true);
  if (!fromDeath) game.flash([0.3, 0.2, 0.6], 0.9);
}

document.getElementById('confirmAscend').addEventListener('click', () => ascend(false));
document.getElementById('rebuildBtn').addEventListener('click', () => ascend(true));

// --- offline earnings -------------------------------------------------------------

if (hadSave) {
  const offline = state.claimOffline();
  if (offline > 0) {
    state.run.coins += offline;
    setTimeout(() => ui.toast(`AUTOPILOT BANKED +${fmt(offline)}`, 'gold', true), 700);
  }
} else if (!state.meta.seenIntro) {
  state.meta.seenIntro = true;
  setTimeout(() => ui.showModal('modalHelp'), 350);
}
ui.updateSpeedButton();
ui.soundBtn.classList.toggle('off', state.meta.settings.sound === false);
if (state.run.over) ui.showRunOver();

// --- main loop -----------------------------------------------------------------

let last = performance.now();
let uiAccum = 0;
let frames = 0;
let fpsAccum = 0;

function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;

  // Cheap every frame, and the only reliable way to catch a viewport that was
  // not measurable at boot (background tab, mobile browser chrome settling)
  // or a DPR change from dragging the window to another monitor.
  resize();

  game.update(dt);
  handleEvents();
  game.render(now / 1000);
  game.renderOverlay(overlayCtx, game.overlayDpr);

  // The DOM only needs ~12 updates a second to feel live.
  uiAccum += dt;
  if (uiAccum >= 0.08) {
    uiAccum = 0;
    ui.refresh();
  }

  // Adaptive quality: if we cannot hold ~50fps, drop the expensive wide bloom
  // pass before we start dropping frames outright.
  frames++;
  fpsAccum += dt;
  if (fpsAccum >= 1) {
    const fps = frames / fpsAccum;
    frames = 0; fpsAccum = 0;
    if (fps < 44 && renderer.bloomIntensity > 0.6) renderer.bloomIntensity = 0.6;
    else if (fps > 56 && renderer.bloomIntensity < 1.15) renderer.bloomIntensity = 1.15;
  }

  state.tickSave(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --- housekeeping ----------------------------------------------------------------

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    state.save();
  } else {
    last = performance.now();   // avoid a huge catch-up dt on return
    synth.resume();
  }
});
window.addEventListener('pagehide', () => state.save());
window.addEventListener('beforeunload', () => state.save());

// Block the pinch-zoom / double-tap-zoom that would fight with tapping upgrades.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());

if (state.storageBlocked) {
  setTimeout(() => ui.toast('SAVING UNAVAILABLE IN THIS BROWSER MODE', 'danger'), 1200);
}
