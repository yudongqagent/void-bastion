// Craft silhouettes, as data.
//
// Each entry is a list of parts in a LOCAL frame where +y is the craft's
// heading and one unit is its radius. That frame is the whole trick: a
// silhouette is written once as a handful of readable coordinates and works at
// any size, any heading, with no sprites anywhere.
//
// These used to be imperative draw calls inside a switch, which meant the
// description existed only for as long as it took to rasterise. As data the
// same recipe drives two things — the living craft, and its wreckage, where
// every part becomes an independent tumbling body. Killing something should
// show you the thing you were looking at coming apart, not a generic puff.
//
// Part types:
//   bar   a beam between two local points, `w` wide          -> becomes wreckage
//   gon   a regular polygon                                  -> becomes wreckage
//   slab  a non-uniform lit quad                             -> becomes wreckage
//   dot   an accent-coloured disc (cockpits, lights)         -> becomes an ember
//   ring  an unrotated ring centred on the craft             -> shockwave on death
//   orbit animated nodes circling the hull                   -> effect only
//
// `m` multiplies brightness. Values above 1 are panel lines and lit edges;
// below 1 is shadowed structure.

const TAU = Math.PI * 2;

/** The Radial Gun's eight barrels, generated rather than hand-typed. */
function radialBarrels() {
  const out = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    out.push({
      t: 'bar',
      a: [Math.cos(a) * 0.6, Math.sin(a) * 0.6],
      b: [Math.cos(a) * 1.05, Math.sin(a) * 1.05],
      w: 0.14, m: 1.0,
    });
  }
  return out;
}

export const CRAFT = {
  drone: [
    { t: 'bar', a: [0, -0.85], b: [0, 1.05], w: 0.30, m: 1.05 },
    { t: 'bar', a: [-1.05, -0.45], b: [0, 0.15], w: 0.22, m: 0.85 },
    { t: 'bar', a: [1.05, -0.45], b: [0, 0.15], w: 0.22, m: 0.85 },
    { t: 'dot', p: [0, 0.40], r: 0.24, m: 2.10 },
  ],

  darter: [
    { t: 'bar', a: [0, -1.1], b: [0, 1.4], w: 0.24, m: 1.10 },
    { t: 'bar', a: [-0.7, -0.5], b: [0, -0.1], w: 0.16, m: 0.80 },
    { t: 'bar', a: [0.7, -0.5], b: [0, -0.1], w: 0.16, m: 0.80 },
    { t: 'dot', p: [0, 0.55], r: 0.20, m: 2.20 },
  ],

  brute: [
    { t: 'gon', p: [0, 0], r: 0.62, sides: 6, rot: 0, m: 0.85 },
    { t: 'bar', a: [-1.5, -0.15], b: [1.5, -0.15], w: 0.30, m: 1.00 },
    { t: 'bar', a: [-1.1, -0.15], b: [-0.85, -0.85], w: 0.22, m: 0.80 },
    { t: 'bar', a: [1.1, -0.15], b: [0.85, -0.85], w: 0.22, m: 0.80 },
    { t: 'bar', a: [0, -0.7], b: [0, 1.0], w: 0.34, m: 1.05 },
    { t: 'dot', p: [0, 0.35], r: 0.26, m: 2.00 },
    { t: 'dot', p: [-0.62, -0.8], r: 0.16, m: 1.80 },
    { t: 'dot', p: [0.62, -0.8], r: 0.16, m: 1.80 },
  ],

  splitter: [
    { t: 'bar', a: [-0.5, -0.8], b: [-0.5, 0.9], w: 0.30, m: 1.00 },
    { t: 'bar', a: [0.5, -0.8], b: [0.5, 0.9], w: 0.30, m: 1.00 },
    { t: 'bar', a: [-0.5, 0.1], b: [0.5, 0.1], w: 0.26, m: 0.80 },
    { t: 'dot', p: [-0.5, 0.5], r: 0.20, m: 1.90 },
    { t: 'dot', p: [0.5, 0.5], r: 0.20, m: 1.90 },
  ],

  shielder: [
    { t: 'gon', p: [0, 0], r: 0.78, sides: 8, rot: 0.8, m: 1.0 },
    { t: 'ring', r: 1.02, w: 0.16, m: 0.7, tint: 'hullFlat', alpha: 0.9 },
    { t: 'dot', p: [0, 0.1], r: 0.30, m: 2.00 },
  ],

  sentinel: [
    { t: 'bar', a: [0, -0.9], b: [0, 1.0], w: 0.42, m: 1.00 },
    { t: 'bar', a: [-1.0, -0.3], b: [-1.0, 0.5], w: 0.26, m: 0.85 },
    { t: 'bar', a: [1.0, -0.3], b: [1.0, 0.5], w: 0.26, m: 0.85 },
    { t: 'bar', a: [-1.0, 0.1], b: [0, 0.1], w: 0.20, m: 0.70 },
    { t: 'bar', a: [1.0, 0.1], b: [0, 0.1], w: 0.20, m: 0.70 },
    { t: 'bar', a: [-1.0, 0.5], b: [-1.0, 1.05], w: 0.12, m: 1.60 },
    { t: 'bar', a: [1.0, 0.5], b: [1.0, 1.05], w: 0.12, m: 1.60 },
    { t: 'dot', p: [0, 0.3], r: 0.26, m: 2.10 },
  ],

  gunship: [
    { t: 'bar', a: [0, -0.8], b: [0, 0.95], w: 0.44, m: 1.00 },
    { t: 'bar', a: [-0.85, -0.2], b: [-0.85, 0.35], w: 0.24, m: 0.85 },
    { t: 'bar', a: [0.85, -0.2], b: [0.85, 0.35], w: 0.24, m: 0.85 },
    { t: 'bar', a: [-0.85, 0.1], b: [0, 0.1], w: 0.18, m: 0.70 },
    { t: 'bar', a: [0.85, 0.1], b: [0, 0.1], w: 0.18, m: 0.70 },
    { t: 'ring', r: 1.15, w: 0.10, m: 0.5, tint: 'hullFlat', alpha: 0.55 },
    { t: 'dot', p: [0, 0.35], r: 0.24, m: 2.00 },
  ],

  radial: [
    { t: 'gon', p: [0, 0], r: 0.6, sides: 8, rot: 0, m: 0.90 },
    ...radialBarrels(),
    { t: 'dot', p: [0, 0], r: 0.30, m: 2.20 },
  ],

  lancer: [
    { t: 'bar', a: [0, -1.0], b: [0, 1.25], w: 0.30, m: 1.00 },
    { t: 'bar', a: [-0.55, 0.35], b: [-0.3, 1.15], w: 0.16, m: 1.20 },
    { t: 'bar', a: [0.55, 0.35], b: [0.3, 1.15], w: 0.16, m: 1.20 },
    { t: 'bar', a: [-0.75, -0.35], b: [0.75, -0.35], w: 0.22, m: 0.80 },
    { t: 'dot', p: [0, 1.2], r: 0.20, m: 2.40 },
    { t: 'dot', p: [0, -0.2], r: 0.24, m: 1.90 },
  ],

  dread: [
    { t: 'gon', p: [0, 0], r: 0.7, sides: 6, rot: 0, m: 0.80 },
    { t: 'bar', a: [0, -1.0], b: [0, 1.1], w: 0.50, m: 0.95 },
    { t: 'bar', a: [-1.25, -0.3], b: [1.25, -0.3], w: 0.32, m: 0.90 },
    { t: 'bar', a: [-1.25, -0.3], b: [-1.05, 0.5], w: 0.28, m: 0.85 },
    { t: 'bar', a: [1.25, -0.3], b: [1.05, 0.5], w: 0.28, m: 0.85 },
    { t: 'bar', a: [-1.05, 0.5], b: [-1.05, 0.95], w: 0.15, m: 1.60 },
    { t: 'bar', a: [1.05, 0.5], b: [1.05, 0.95], w: 0.15, m: 1.60 },
    { t: 'dot', p: [0, -0.05], r: 0.30, m: 2.10 },
  ],

  wraith: [
    { t: 'gon', p: [0, 0.1], r: 0.95, sides: 3, rot: 0, m: 0.70 },
    { t: 'bar', a: [-0.95, -0.5], b: [0.95, -0.5], w: 0.18, m: 1.10 },
    { t: 'dot', p: [0, 0.3], r: 0.20, m: 1.90 },
  ],

  boss: [
    { t: 'gon', p: [0, 0], r: 0.72, sides: 6, rot: 0, m: 0.75 },
    { t: 'bar', a: [0, -1.0], b: [0, 1.1], w: 0.55, m: 0.95 },
    { t: 'bar', a: [-1.35, -0.35], b: [1.35, -0.35], w: 0.34, m: 0.90 },
    { t: 'bar', a: [-1.35, -0.35], b: [-1.15, 0.55], w: 0.30, m: 0.85 },
    { t: 'bar', a: [1.35, -0.35], b: [1.15, 0.55], w: 0.30, m: 0.85 },
    { t: 'bar', a: [-1.15, 0.55], b: [-1.15, 1.0], w: 0.16, m: 1.70 },
    { t: 'bar', a: [1.15, 0.55], b: [1.15, 1.0], w: 0.16, m: 1.70 },
    { t: 'bar', a: [0, 0.6], b: [0, 1.25], w: 0.20, m: 1.80 },
    { t: 'dot', p: [0, -0.1], r: 0.34, m: 2.20 },
    { t: 'dot', p: [-0.55, -0.75], r: 0.20, m: 1.60 },
    { t: 'dot', p: [0.55, -0.75], r: 0.20, m: 1.60 },
  ],

  mite: [
    { t: 'bar', a: [0, -0.6], b: [0, 0.9], w: 0.40, m: 1.10 },
    { t: 'dot', p: [0, 0.35], r: 0.32, m: 2.20 },
  ],

  bomber: [
    { t: 'gon', p: [0, -0.05], r: 0.72, sides: 4, rot: 0.78, m: 0.95 },
    { t: 'bar', a: [-0.9, -0.3], b: [0.9, -0.3], w: 0.22, m: 0.85 },
    { t: 'dot', p: [0, 0.62], r: 0.34, m: 2.40 },
    { t: 'ring', r: 0.95, w: 0.13, m: 1.0, tint: 'accent', alpha: 0.7 },
  ],

  juggernaut: [
    { t: 'gon', p: [0, 0], r: 0.9, sides: 7, rot: 0.2, m: 0.70 },
    { t: 'gon', p: [0, 0], r: 0.62, sides: 7, rot: 0.5, m: 0.95 },
    { t: 'bar', a: [-1.15, -0.25], b: [1.15, -0.25], w: 0.30, m: 0.80 },
    { t: 'bar', a: [-1.15, 0.35], b: [1.15, 0.35], w: 0.30, m: 0.80 },
    { t: 'bar', a: [0, -0.9], b: [0, 0.95], w: 0.40, m: 1.05 },
    { t: 'dot', p: [0, 0.25], r: 0.20, m: 2.00 },
  ],

  sniper: [
    { t: 'bar', a: [0, -0.7], b: [0, 1.5], w: 0.16, m: 1.20 },
    { t: 'bar', a: [-0.55, -0.35], b: [0.55, -0.35], w: 0.20, m: 0.90 },
    { t: 'bar', a: [-0.3, -0.6], b: [0.3, -0.6], w: 0.16, m: 0.80 },
    { t: 'dot', p: [0, 1.42], r: 0.16, m: 2.60 },
    { t: 'dot', p: [0, -0.3], r: 0.20, m: 1.80 },
  ],

  warden: [
    { t: 'gon', p: [0, 0], r: 0.62, sides: 6, rot: 0.3, m: 0.90 },
    { t: 'ring', r: 1.1, w: 0.12, m: 0.8, tint: 'accent', alpha: 0.8 },
    { t: 'orbit', n: 3, r: 1.1, size: 0.13, speed: 0.9 },
    { t: 'dot', p: [0, 0], r: 0.30, m: 2.00 },
  ],

  turret: [
    { t: 'ring', r: 1.05, w: 0.2, m: 1.2, tint: 'hull', alpha: 1 },
    { t: 'gon', p: [0, 0], r: 0.66, sides: 8, rot: 0.2, m: 1.00 },
    { t: 'bar', a: [-0.24, 0.1], b: [-0.24, 1.15], w: 0.14, m: 1.30 },
    { t: 'bar', a: [0.24, 0.1], b: [0.24, 1.15], w: 0.14, m: 1.30 },
    { t: 'dot', p: [0, 0], r: 0.26, m: 2.00 },
  ],

  tank: [
    { t: 'bar', a: [-0.72, -0.7], b: [-0.72, 0.7], w: 0.30, m: 0.85 },
    { t: 'bar', a: [0.72, -0.7], b: [0.72, 0.7], w: 0.30, m: 0.85 },
    { t: 'slab', p: [0, 0], hw: 0.62, hh: 0.72, m: 1.0, shade: 0.9 },
    { t: 'gon', p: [0, 0.05], r: 0.44, sides: 6, rot: 0.3, m: 1.15 },
    { t: 'bar', a: [0, 0.3], b: [0, 1.2], w: 0.13, m: 1.30 },
    { t: 'dot', p: [0, 0.05], r: 0.20, m: 1.90 },
  ],

  warship: [
    { t: 'slab', p: [0, 0], hw: 0.42, hh: 1.15, m: 1.0, shade: 0.95 },
    { t: 'slab', p: [0, -0.15], hw: 0.3, hh: 0.4, m: 1.3, shade: 0.8 },
    { t: 'bar', a: [-0.34, 0.55], b: [-0.34, 1.0], w: 0.12, m: 1.30 },
    { t: 'bar', a: [0.34, 0.55], b: [0.34, 1.0], w: 0.12, m: 1.30 },
    { t: 'bar', a: [0, -0.5], b: [0, -1.0], w: 0.16, m: 1.10 },
    { t: 'dot', p: [0, -0.15], r: 0.20, m: 1.80 },
    { t: 'dot', p: [0, 0.75], r: 0.14, m: 1.60 },
  ],

  sam: [
    { t: 'ring', r: 0.95, w: 0.16, m: 1.2, tint: 'hull', alpha: 1 },
    { t: 'gon', p: [0, 0], r: 0.55, sides: 6, rot: 0, m: 1.00 },
    { t: 'bar', a: [-0.32, -0.1], b: [-0.32, 0.95], w: 0.17, m: 1.20 },
    { t: 'dot', p: [-0.32, 0.9], r: 0.13, m: 2.20 },
    { t: 'bar', a: [0.32, -0.1], b: [0.32, 0.95], w: 0.17, m: 1.20 },
    { t: 'dot', p: [0.32, 0.9], r: 0.13, m: 2.20 },
    { t: 'dot', p: [0, 0], r: 0.22, m: 1.70 },
  ],
};

export const craftParts = (type) => CRAFT[type] || CRAFT.drone;

/** Parts that become physical wreckage. Rings and orbit nodes are effects. */
export const SOLID_PARTS = new Set(['bar', 'gon', 'slab']);

/**
 * Reduce a part to a rigid body in the craft's local frame.
 *
 * A `bar` is authored as two endpoints, but as wreckage it is a rod tumbling
 * about its own centre — so it has to be re-expressed as a centre, an extent
 * and an angle. Doing that conversion here keeps every piece of geometry
 * knowledge about a recipe in this file; game.js only ever sees bodies.
 *
 * Returns null for parts that are light rather than structure.
 */
export function partBody(part) {
  switch (part.t) {
    case 'bar': {
      const dx = part.b[0] - part.a[0], dy = part.b[1] - part.a[1];
      const len = Math.hypot(dx, dy);
      return {
        cx: (part.a[0] + part.b[0]) / 2,
        cy: (part.a[1] + part.b[1]) / 2,
        shape: 'slab',
        // The recipe's angle is measured from +y, matching the local frame.
        rot: Math.atan2(dy, dx) - Math.PI / 2,
        hw: part.w / 2,
        hh: len / 2,
        m: part.m,
      };
    }
    case 'slab':
      return { cx: part.p[0], cy: part.p[1], shape: 'slab', rot: 0,
        hw: part.hw, hh: part.hh, m: part.m };
    case 'gon':
      return { cx: part.p[0], cy: part.p[1], shape: 'gon', rot: part.rot,
        r: part.r, sides: part.sides, m: part.m };
    default:
      return null;
  }
}

/** Rigid bodies for one craft type, computed once and cached. */
const BODY_CACHE = new Map();
export function craftBodies(type) {
  let bodies = BODY_CACHE.get(type);
  if (!bodies) {
    bodies = craftParts(type).map(partBody).filter(Boolean);
    BODY_CACHE.set(type, bodies);
  }
  return bodies;
}
