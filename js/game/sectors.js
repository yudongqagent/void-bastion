// Zones — the scrolling map's variety layer.
//
// The ship never stops flying forward, so "the map" is really the parade of
// scenery and hazards that comes down past it. Every BOSS_INTERVAL waves the
// run crosses into a new zone with its own palette, backdrop haze, scroll
// speed, hazard density and one rule twist. This is what stops wave 300 from
// looking exactly like wave 30 — the failure mode an endless game is most
// prone to.
//
// Design rule for the modifiers: **nothing here may hard-counter an idle
// player.** Each zone pairs a small cost with a small benefit. Someone who
// leaves the tab running should read zones as flavour and rhythm, never as the
// reason a run died. Debris is a hazard the autopilot actively dodges, so it
// is spectacle first and threat second.

export const SECTORS = [
  {
    id: 'outer-reach', grade: [1.00, 1.02, 1.10], saturation: 1.00, rain: 0,
    name: 'OUTER REACH',
    tagline: 'Open space. Clear skies.',
    bg: [0.017, 0.021, 0.043],
    haze: [0.10, 0.26, 0.55],
    starTint: [0.55, 0.72, 1.00],
    scrollMult: 1.0,
    coinMult: 1.0, hpMult: 1.0, speedMult: 1.0,
    note: 'Baseline space.',
  },
  {
    id: 'asteroid-belt', grade: [1.10, 1.02, 0.88], saturation: 0.88, rain: 0,
    name: 'ASTEROID BELT',
    tagline: 'Rock everywhere. Mind the drift.',
    bg: [0.030, 0.023, 0.036],
    haze: [0.55, 0.34, 0.18],
    starTint: [1.00, 0.78, 0.52],
    scrollMult: 1.0,
    coinMult: 1.18, hpMult: 1.0, speedMult: 1.0,
    note: '+18% coins from ore salvage.',
  },
  {
    id: 'ion-storm', grade: [0.92, 1.00, 1.16], saturation: 1.06, rain: 1,
    name: 'ION STORM',
    tagline: 'Lightning stuns whatever it touches.',
    bg: [0.022, 0.026, 0.062],
    haze: [0.32, 0.55, 1.00],
    starTint: [0.70, 0.85, 1.00],
    scrollMult: 1.25,
    coinMult: 1.0, hpMult: 1.0, speedMult: 1.10,
    effect: 'storm',
    note: 'Faster run, faster enemies — but storm arcs stun them.',
  },
  {
    id: 'crimson-nebula', grade: [1.14, 0.94, 0.96], saturation: 1.02, rain: 0,
    name: 'CRIMSON NEBULA',
    tagline: 'The swarm knits itself back together.',
    bg: [0.048, 0.013, 0.024],
    haze: [1.00, 0.20, 0.34],
    starTint: [1.00, 0.60, 0.66],
    scrollMult: 0.85,
    coinMult: 1.32, hpMult: 1.0, speedMult: 0.94,
    enemyRegen: 0.010,
    effect: 'fog',
    note: 'Enemies regenerate, but pay far better.',
  },
  {
    id: 'derelict-fleet', grade: [0.98, 1.00, 0.98], saturation: 0.80, rain: 1,
    name: 'DERELICT FLEET',
    tagline: 'Dead hulls drifting in the lane.',
    bg: [0.020, 0.029, 0.033],
    haze: [0.24, 0.70, 0.60],
    starTint: [0.62, 1.00, 0.90],
    scrollMult: 0.95,
    coinMult: 1.0, hpMult: 1.12, speedMult: 0.90,
    note: 'Tougher enemies, but they move slowly here.',
  },
  {
    id: 'void-rift', grade: [1.04, 0.94, 1.16], saturation: 1.10, rain: 0,
    name: 'VOID RIFT',
    tagline: 'Reality thins. Everything comes at once.',
    bg: [0.029, 0.013, 0.050],
    haze: [0.62, 0.30, 1.00],
    starTint: [0.80, 0.62, 1.00],
    scrollMult: 1.35,
    coinMult: 1.25, hpMult: 1.0, speedMult: 1.05,
    effect: 'rift',
    note: 'Dense and fast — and it pays for the trouble.',
  },
];

/** Which zone a wave belongs to. Zones cycle forever. */
export function sectorForWave(wave, interval) {
  return SECTORS[sectorNumber(wave, interval) % SECTORS.length];
}

/** 0-based count of how many zones deep the run is. */
export function sectorNumber(wave, interval) {
  return Math.floor((wave - 1) / interval);
}

/** True on the first wave of a new zone. */
export function isSectorStart(wave, interval) {
  return (wave - 1) % interval === 0;
}
