// Airframe vocabulary.
//
// The old recipe language had bars, polygons and slabs — enough to sketch a
// silhouette, not enough to describe an aircraft. A fuselage built from a
// capsule is a sausage; a wing built from a capsule is a stick. No amount of
// baking, ambient occlusion or material detail fixes that, because the shape
// itself carries no information.
//
// These primitives describe anatomy instead, and each one owns a HEIGHT
// PROFILE, so the baker gets genuine volume rather than an extruded outline.
// Everything lives in the same local frame as before: +y is the heading, and
// one unit is the craft's radius.
//
// `mirror: true` emits the x-mirrored twin of a part. A wing pair, a nacelle
// pair and a pylon pair are one line each, which is what makes 25-part craft
// affordable both to write and to read.

/** Tapered fuselage. Stations run nose (high y) to tail, [y, halfWidth, height]. */
export const loft = (stations, o = {}) => ({ t: 'loft', st: stations, m: o.m ?? 1, ...o });

/**
 * Swept wing.
 *
 * Described the way a wing actually is — a root chord at the fuselage, a tip
 * chord out at the span, and a sweep offsetting the tip aft — rather than as a
 * line with a thickness. The baker gives it an airfoil section, thick at the
 * leading edge and root and thin at the tip and trailing edge.
 */
export const wing = (o) => ({
  t: 'wing',
  y: o.y, root: o.root, tip: o.tip ?? o.root * 0.45,
  span: o.span, x0: o.x0 ?? 0.12, sweep: o.sweep ?? 0.28,
  h: o.h ?? 0.10, m: o.m ?? 1, mirror: o.mirror ?? true,
});

/** Engine pod: a tube with a recessed intake and a lit nozzle at the tail. */
export const nacelle = (o) => ({
  t: 'nacelle',
  p: o.p, len: o.len, r: o.r,
  h: o.h ?? 0.30, nozzle: o.nozzle ?? true, intake: o.intake ?? true,
  m: o.m ?? 1, mirror: o.mirror ?? false,
});

/** Glazed blister. Always forced to the canopy-glass material by the baker. */
export const canopy = (o) => ({
  t: 'canopy', p: o.p, rx: o.rx, ry: o.ry, h: o.h ?? 0.34, m: o.m ?? 1,
  mirror: o.mirror ?? false,
});

/** Vertical surface — fin or tailplane. Sits above the fuselage it mounts on. */
export const fin = (o) => ({
  t: 'fin', p: o.p, len: o.len, hw: o.hw ?? 0.05,
  sweep: o.sweep ?? 0.10, h: o.h ?? 0.38, m: o.m ?? 1, mirror: o.mirror ?? false,
});

/** Underwing hardpoint. */
export const pylon = (o) => ({
  t: 'pylon', p: o.p, hw: o.hw ?? 0.05, hh: o.hh ?? 0.13,
  h: o.h ?? 0.16, m: o.m ?? 1, mirror: o.mirror ?? true,
});

/** Ordnance hanging off a pylon — a visible reason the craft is dangerous. */
export const store = (o) => ({
  t: 'store', p: o.p, len: o.len, r: o.r ?? 0.055,
  h: o.h ?? 0.14, m: o.m ?? 1, mirror: o.mirror ?? true,
});

/** Flat plate: decks, sponsons, superstructure. */
export const plate = (o) => ({
  t: 'plate', p: o.p, hw: o.hw, hh: o.hh, rot: o.rot ?? 0,
  h: o.h ?? 0.22, m: o.m ?? 1, mirror: o.mirror ?? false,
});

/** Rotating housing or dome — turret mounts, sensor blisters. */
export const dome = (o) => ({
  t: 'dome', p: o.p, r: o.r, h: o.h ?? 0.34, m: o.m ?? 1,
  mirror: o.mirror ?? false,
});

/** Gun barrel. Thin, and it should break the silhouette. */
export const barrel = (o) => ({
  t: 'barrel', p: o.p, len: o.len, r: o.r ?? 0.035,
  ang: o.ang ?? 0, h: o.h ?? 0.24, m: o.m ?? 1, mirror: o.mirror ?? false,
});

/** Running light. */
export const lamp = (p, r, m = 2) => ({ t: 'dot', p, r, m });

/** Static ring — shield emitters, base rings. Drawn live, not baked. */
export const ring = (o) => ({
  t: 'ring', r: o.r, w: o.w, tint: o.tint ?? 'accent', alpha: o.alpha ?? 0.6, m: o.m ?? 1,
});

/** Orbiting nodes. Drawn live. */
export const orbit = (o) => ({
  t: 'orbit', n: o.n, r: o.r, size: o.size, speed: o.speed, m: o.m ?? 1,
});

/**
 * Expand `mirror` flags into explicit twins.
 *
 * Done once at module load so every consumer — baker, live renderer, wreckage —
 * sees the same flat list and none of them has to know mirroring exists.
 */
export function expand(parts) {
  const out = [];
  for (const p of parts) {
    out.push(p);
    if (!p.mirror) continue;
    const q = { ...p, mirror: false };
    switch (p.t) {
      case 'wing': q.span = -p.span; q.x0 = -p.x0; break;
      case 'loft': q.st = p.st.map(([y, w, h]) => [y, w, h]); break;
      default:
        if (p.p) q.p = [-p.p[0], p.p[1]];
        if (p.ang !== undefined) q.ang = -p.ang;
        break;
    }
    out.push(q);
  }
  return out;
}

/** Parts that become physical wreckage when a craft dies. */
export const SOLID = new Set(['loft', 'wing', 'nacelle', 'canopy', 'fin',
  'pylon', 'store', 'plate', 'dome', 'barrel']);
