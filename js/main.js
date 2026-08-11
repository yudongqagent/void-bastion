// VOID BASTION — entry point. Boots the renderer, wires the loop, translates
// game events into UI reactions.

import { Renderer } from './gl/renderer.js';
import { Game } from './game/game.js';
import { GameState, freshRun } from './game/state.js';
import { Synth } from './audio/synth.js';
import { UI } from './ui/hud.js';
import { fmt } from './game/balance.js';

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

// Freezing the screen is exactly the class of effect this setting exists for.
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const applyMotion = () => { game.reducedMotion = motionQuery.matches; };
applyMotion();
if (motionQuery.addEventListener) motionQuery.addEventListener('change', applyMotion);

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
  const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
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

// --- player control -------------------------------------------------------
//
// Drag anywhere on the play area to fly the ship there; release and the
// autopilot eases back in. Handlers sit on the scene canvas rather than the
// window so the permanent upgrade panel, which is painted over it, keeps its
// own taps instead of also flying the ship.

let steering = false;

function playPoint(e) {
  const r = sceneCanvas.getBoundingClientRect();
  // Touch aims above the finger; a mouse pointer does not need the clearance.
  const lift = e.pointerType === 'touch' ? 46 : 0;
  return { x: e.clientX - r.left, y: e.clientY - r.top, lift };
}

sceneCanvas.addEventListener('pointerdown', (e) => {
  if (ui.openModal) return;
  steering = true;
  const p = playPoint(e);
  game.setManualTarget(p.x, p.y, p.lift);
  try { sceneCanvas.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
  e.preventDefault();
});
sceneCanvas.addEventListener('pointermove', (e) => {
  if (!steering) return;
  const p = playPoint(e);
  game.setManualTarget(p.x, p.y, p.lift);
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
  sceneCanvas.addEventListener(ev, () => { steering = false; game.releaseManual(); });
}

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
        ui.toast(`${ev.data.name} INBOUND`, 'danger', true);
        break;
      case 'bossKill':
        ui.toast('BOSS DESTROYED', 'gold');
        break;
      case 'sector':
        ui.setZone(ev.data.sector);
        break;
      case 'levelStart':
        ui.showLevelCard(ev.data);
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

/**
 * End the current run and begin a fresh one.
 *
 * Banking is idempotent and already happened at the moment of death, so this is
 * safe on both paths: REBUILD after losing, and a voluntary ASCEND.
 */
function startNewRun(fromDeath) {
  const cores = state.bankRun();

  state.run = freshRun(state.meta);
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
  game.flashAmount = 0;
  game.paused = false;

  state.save();
  ui.forceHideModal();
  ui.buildUpgradeRows();
  ui.buildAbilityBar();
  ui.syncInsets();
  synth.prestige();
  if (cores > 0) ui.toast(`ASCENDED — +${fmt(cores)} CORES`, 'violet', true);
  if (!fromDeath) game.flash([0.3, 0.2, 0.6], 0.9);
}

document.getElementById('confirmAscend').addEventListener('click', () => startNewRun(false));
document.getElementById('rebuildBtn').addEventListener('click', () => startNewRun(true));

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

// Changing tier restarts the run: enemy scaling is applied when a wave is
// built, so a half-flown level would be mismatched against the next one.
ui.onDifficultyChange = () => startNewRun(false);
ui.showHome();
ui.setZone(game.sector);
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

  // Adaptive quality. The bottleneck is fill rate, not CPU, so the ladder walks
  // down the most expensive things first: the extra wide-bloom passes, then the
  // resolution the world is rendered at. Both are far less noticeable than a
  // dropped frame, and it climbs back once there is headroom.
  frames++;
  fpsAccum += dt;
  if (fpsAccum >= 1.2) {
    const fps = frames / fpsAccum;
    frames = 0; fpsAccum = 0;
    if (fps < 50) {
      if (renderer.wideBloom) renderer.wideBloom = false;
      else renderer.setQuality(renderer.quality - 0.1);
    } else if (fps > 58) {
      if (renderer.quality < 1) renderer.setQuality(renderer.quality + 0.05);
      else if (!renderer.wideBloom) renderer.wideBloom = true;
    }
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
