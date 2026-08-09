// Levels.
//
// The run is a sequence of discrete levels rather than an undifferentiated
// stream of waves. Each level is one map, four enemy phases and a boss that
// belongs to it, taking roughly ninety seconds — long enough to have its own
// character, short enough that a run still shows you a dozen of them.
//
// Internally the old wave counter survives as the difficulty index, because
// every formula in balance.js is tuned against it. A level is simply five of
// those steps: four phases and a boss. That keeps the economy intact while the
// player sees structure instead of an odometer.

import { SECTORS } from './sectors.js';

/** Phases before the boss. Five internal steps per level in total. */
export const PHASES_PER_LEVEL = 4;
export const STEPS_PER_LEVEL = PHASES_PER_LEVEL + 1;

export const levelOf = (wave) => Math.floor((wave - 1) / STEPS_PER_LEVEL) + 1;
export const phaseOf = (wave) => ((wave - 1) % STEPS_PER_LEVEL) + 1;
export const isBossStep = (wave) => phaseOf(wave) === STEPS_PER_LEVEL;
export const firstStepOfLevel = (wave) => phaseOf(wave) === 1;

/**
 * Boss roster. Each has its own silhouette and, more importantly, its own
 * attack pattern — a boss you beat by hugging one side is a different fight
 * from one that fills the lane, and that is what makes levels memorable rather
 * than merely numbered.
 */
export const BOSSES = [
  {
    id: 'harbour', name: 'HARBOUR GUN', pattern: 'spiral',
    hp: 1.00, radius: 30, accent: [1.60, 0.45, 0.25],
    tell: 'Rotating batteries — keep moving around it.',
  },
  {
    id: 'walker', name: 'SIEGE WALKER', pattern: 'sweep',
    hp: 1.10, radius: 32, accent: [1.35, 0.85, 0.25],
    tell: 'Sweeping volleys — slip through the gaps.',
  },
  {
    id: 'carrier', name: 'STORM CARRIER', pattern: 'launch',
    hp: 1.25, radius: 36, accent: [0.45, 0.95, 1.60],
    tell: 'Launches escorts — kill the flights first.',
  },
  {
    id: 'fortress', name: 'RAIL FORTRESS', pattern: 'lance',
    hp: 1.15, radius: 33, accent: [1.55, 0.35, 0.55],
    tell: 'Charges rail columns — watch the sight-lines.',
  },
  {
    id: 'hive', name: 'HIVE BARGE', pattern: 'swarm',
    hp: 1.20, radius: 34, accent: [0.45, 1.45, 0.60],
    tell: 'Spits splitters — do not let them stack.',
  },
  {
    id: 'monolith', name: 'VOID MONOLITH', pattern: 'burst',
    hp: 1.35, radius: 38, accent: [0.85, 0.50, 1.60],
    tell: 'Ring bursts — stay off the detonation lines.',
  },
];

/**
 * Boss for a level. Map and boss cycle at different rates so pairings keep
 * rotating instead of locking together after the first loop.
 */
export function bossForLevel(level) {
  const i = (level - 1 + Math.floor((level - 1) / SECTORS.length)) % BOSSES.length;
  return BOSSES[i];
}

export function sectorForLevel(level) {
  return SECTORS[(level - 1) % SECTORS.length];
}

/** How many times the roster has looped — drives naming and extra menace. */
export function tierOf(level) {
  return Math.floor((level - 1) / SECTORS.length);
}

const ROMAN = ['', ' II', ' III', ' IV', ' V', ' VI', ' VII', ' VIII', ' IX', ' X'];
// ROMAN[0] is '' which is falsy, so a plain `||` fallback printed " 1" on tier 0.
const numeral = (t) => (t < ROMAN.length ? ROMAN[t] : ' ' + (t + 1));

export function bossName(level) {
  const b = bossForLevel(level);
  const t = tierOf(level);
  return b.name + numeral(t);
}

export function levelName(level) {
  const s = sectorForLevel(level);
  const t = tierOf(level);
  return s.name + numeral(t);
}

/**
 * Discrete between-level enemy upgrade.
 *
 * The per-step curve already climbs, but a smooth climb is invisible. Stepping
 * hull and damage at each level boundary makes "the enemies got upgraded" a
 * thing the player can feel, and gives the level-start banner something true
 * to announce.
 */
export function levelUpgrade(level) {
  const t = tierOf(level);
  return {
    hp: 1 + t * 0.06,
    dmg: 1 + t * 0.05,
    label: t > 0 ? `ENEMY REFIT${numeral(t)}` : null,
  };
}
