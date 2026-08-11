import { AIRFRAME_PARTS } from './airframes.js';
import { SOLID } from './airframe.js';

/**
 * The parts of one craft, mirrors already resolved.
 *
 * Single source of truth: the live renderer's fallback, the offline baker and
 * the wreckage system all read this, so a craft cannot come apart into pieces
 * it was never built from.
 */
export const craftParts = (type) => AIRFRAME_PARTS[type] || AIRFRAME_PARTS.drone;

/** Axis-aligned extent of a part, in local units: [cx, cy, halfW, halfH]. */
function partExtent(p) {
  switch (p.t) {
    case 'loft': {
      const ys = p.st.map((s) => s[0]);
      const w = Math.max(...p.st.map((s) => s[1]));
      const hi = Math.max(...ys), lo = Math.min(...ys);
      return [0, (hi + lo) / 2, w, (hi - lo) / 2];
    }
    case 'wing': {
      const xr = p.x0, xt = p.x0 + p.span;
      const yHi = Math.max(p.y + p.root / 2, p.y + p.tip / 2 - p.sweep);
      const yLo = Math.min(p.y - p.root / 2, p.y - p.tip / 2 - p.sweep);
      return [(xr + xt) / 2, (yHi + yLo) / 2, Math.abs(xt - xr) / 2, (yHi - yLo) / 2];
    }
    case 'nacelle': case 'store':
      return [p.p[0], p.p[1], p.r, p.len / 2];
    case 'canopy': return [p.p[0], p.p[1], p.rx, p.ry];
    case 'fin': return [p.p[0] - p.sweep / 2, p.p[1] - p.len / 2, p.hw, p.len / 2];
    case 'pylon': case 'plate': return [p.p[0], p.p[1], p.hw, p.hh];
    case 'dome': return [p.p[0], p.p[1], p.r, p.r];
    case 'barrel': {
      const a = p.ang || 0;
      const dx = -Math.sin(a) * p.len / 2, dy = Math.cos(a) * p.len / 2;
      return [p.p[0] + dx, p.p[1] + dy, Math.max(p.r, Math.abs(dx)), Math.max(p.r, Math.abs(dy))];
    }
    default: return null;
  }
}

/**
 * Rigid bodies for wreckage, and the shapes the untextured fallback draws.
 *
 * Both want the same thing — a crude solid stand-in for each structural part —
 * so they share one derivation rather than drifting apart.
 */
const BODY_CACHE = new Map();
export function craftBodies(type) {
  let bodies = BODY_CACHE.get(type);
  if (bodies) return bodies;
  bodies = [];
  for (const p of craftParts(type)) {
    if (!SOLID.has(p.t)) continue;
    const e = partExtent(p);
    if (!e) continue;
    const [cx, cy, hw, hh] = e;
    const round = p.t === 'canopy' || p.t === 'dome';
    bodies.push({
      cx, cy, shape: round ? 'gon' : 'slab', rot: p.rot || 0,
      hw, hh, r: Math.max(hw, hh), sides: round ? 9 : 4, m: p.m || 1,
    });
  }
  BODY_CACHE.set(type, bodies);
  return bodies;
}

export const CRAFT_MATERIAL = {
  ship:       [1, 20],   // brushed steel — the player's own airframe
  drone:      [0, 24],   // painted plate — the standard fighter skin
  darter:     [2, 16],   // carbon weave — light and fast
  brute:      [4, 30],   // ceramic armour
  splitter:   [3, 22],   // worn plate — it is meant to look expendable
  shielder:   [8, 26],   // canopy glass — the emitter is glazed
  sentinel:   [1, 22],   // brushed steel
  gunship:    [5, 30],   // military camo
  radial:     [7, 24],   // dark composite
  lancer:     [2, 18],   // carbon weave
  dread:      [4, 40],   // ceramic armour, big plates
  wraith:     [7, 22],   // dark composite — stealth
  boss:       [15, 44],  // hazard stripe — unmistakable
  mite:       [1, 12],   // brushed steel, stamped thin
  bomber:     [15, 22],  // hazard stripe — it is a walking warning
  juggernaut: [4, 46],   // ceramic armour, very large plates
  sniper:     [1, 16],   // brushed steel rail
  warden:     [10, 20],  // thermal foil — support craft wrapped in blanket
  turret:     [11, 26],  // concrete emplacement
  tank:       [5, 26],   // military camo
  warship:    [6, 34],   // oxidised iron — sea-worn
  sam:        [11, 26],  // concrete
};

/** Materials used by things that are not craft. */
export const MAT = {
  ISLAND: 12,   // rock
  SHORE: 13,    // sand
  BASE: 11,     // concrete
  HULL_SEA: 3,  // worn plate — grey steel, not the orange of full oxidisation
  WRECK: 14,    // scorched metal
  NONE: -1,
};

export const materialFor = (type) => CRAFT_MATERIAL[type] || CRAFT_MATERIAL.drone;
