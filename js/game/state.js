// Persistent state for VOID BASTION.
//
// The split that matters: `run` is everything wiped when you die or ascend,
// `meta` is everything that survives forever. Only `meta` plus a light snapshot
// of the current run is written to localStorage.

import { LAB, ABILITIES, startingWave, startingCoins, labMult, deriveStats } from './balance.js';

const KEY = 'void-bastion:save:v1';
const SAVE_INTERVAL_MS = 4000;

export function freshMeta() {
  return {
    cores: 0,
    prestiges: 0,
    lab: {},
    abilities: {},        // key -> true once unlocked
    bestWave: 0,
    totalKills: 0,
    totalRuns: 0,
    lastSeen: Date.now(),
    settings: { sound: true, speed: 1, autoBuy: false },
    seenIntro: false,
  };
}

export function freshRun(meta) {
  const wave = startingWave(meta.lab.labStartWave);
  const stats = deriveStats({}, meta.lab, meta.prestiges);
  return {
    wave,
    startWave: wave,
    upgrades: {},
    coins: startingCoins(meta.lab.labStartCash),
    hull: stats.maxHull,
    shield: stats.maxShield,
    kills: 0,
    elapsed: 0,
    cooldowns: {},        // ability key -> seconds remaining
    over: false,
  };
}

export class GameState {
  constructor() {
    this.meta = freshMeta();
    this.run = freshRun(this.meta);
    this._lastSave = 0;
    this._dirty = false;
  }

  load() {
    let raw;
    try {
      raw = localStorage.getItem(KEY);
    } catch {
      // Private browsing or blocked storage — play on, just without saves.
      this.storageBlocked = true;
      return false;
    }
    if (!raw) return false;
    try {
      const data = JSON.parse(raw);
      if (!data || data.v !== 1) return false;
      this.meta = { ...freshMeta(), ...data.meta };
      this.meta.settings = { ...freshMeta().settings, ...(data.meta.settings || {}) };
      this.meta.lab = data.meta.lab || {};
      this.meta.abilities = data.meta.abilities || {};
      this.run = data.run ? { ...freshRun(this.meta), ...data.run } : freshRun(this.meta);
      // A run saved mid-death should not resume as a corpse.
      if (this.run.hull <= 0) this.run = freshRun(this.meta);
      return true;
    } catch {
      return false;
    }
  }

  markDirty() { this._dirty = true; }

  /** Throttled autosave; call every frame, it decides when to actually write. */
  tickSave(now) {
    if (!this._dirty) return;
    if (now - this._lastSave < SAVE_INTERVAL_MS) return;
    this.save();
  }

  save() {
    this._lastSave = performance.now();
    this._dirty = false;
    this.meta.lastSeen = Date.now();
    try {
      localStorage.setItem(KEY, JSON.stringify({
        v: 1,
        meta: this.meta,
        run: {
          wave: this.run.wave, startWave: this.run.startWave,
          upgrades: this.run.upgrades, coins: this.run.coins,
          hull: this.run.hull, shield: this.run.shield,
          kills: this.run.kills, elapsed: this.run.elapsed,
        },
      }));
    } catch {
      this.storageBlocked = true;
    }
  }

  reset() {
    try { localStorage.removeItem(KEY); } catch { /* nothing to do */ }
    this.meta = freshMeta();
    this.run = freshRun(this.meta);
  }

  /**
   * Coins accrued while the tab was closed, if Autopilot is researched.
   * Capped at 8 hours so leaving for a week is generous but not game-breaking.
   */
  claimOffline() {
    const lvl = this.meta.lab.labOffline || 0;
    if (!lvl || !this.meta.lastSeen) return 0;
    const secs = Math.min(8 * 3600, (Date.now() - this.meta.lastSeen) / 1000);
    if (secs < 60) return 0;
    // Rate is based on the best wave ever reached, not the current one, so
    // idling always pays out at your peak rather than your restart.
    const rate = 0.55 * Math.pow(1.03, Math.max(1, this.meta.bestWave)) * labMult('labOffline', lvl);
    const gained = rate * secs * 0.02;
    return Math.floor(gained);
  }

  abilityUnlocked(key) { return !!this.meta.abilities[key]; }

  unlockedAbilities() {
    return Object.keys(ABILITIES).filter((k) => this.meta.abilities[k]);
  }

  labLevel(key) { return this.meta.lab[key] || 0; }

  labAtMax(key) {
    const max = LAB[key].maxLevel;
    return max != null && this.labLevel(key) >= max;
  }
}
