// The land.
//
// Terrain used to be convex polygons floating on a plane: `makeIsland` built
// 3-5 lobes and drew each as a heptagon with a concentric sand ring. A convex
// polygon cannot make a bay, so it cannot make a coastline, so the map could
// never read as land however good the texture on it was. Same mistake as the
// craft — the shape carried no information and I kept improving the surface.
//
// This is a continuous heightfield instead, sampled on a grid and scrolling
// forever in y. Coastlines are a contour of the field, so bays, spits and
// headlands come out on their own; relief is the field's gradient; and one
// landmass can run off the lane and come back, because there is only ever one
// field rather than a series of islands.

/** Deterministic integer hash -> [0,1). */
function hash2(ix, iy) {
  let h = (ix * 374761393 + iy * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Value noise. Not tiled — the world is infinite in y, so it must not wrap. */
function noise(x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = smooth(x - x0), fy = smooth(y - y0);
  return lerp(
    lerp(hash2(x0, y0), hash2(x0 + 1, y0), fx),
    lerp(hash2(x0, y0 + 1), hash2(x0 + 1, y0 + 1), fx), fy);
}

function fbm(x, y, octaves, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * f + i * 31.7, y * f + i * 17.3) * amp;
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

/** Ridged noise — the basis of both mountain spines and river channels. */
function ridge(x, y, octaves) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let i = 0; i < octaves; i++) {
    const n = Math.abs(noise(x * f + i * 51.1, y * f + i * 23.9) - 0.5) * 2;
    sum += (1 - n) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

// Bands. Everything below SEA is open water and simply is not drawn.
// Set from the measured distribution (p50 0.488, p75 0.560, p92 0.625,
// p99.5 0.732), not guessed. Sea sits just under the median so a bit over a
// third of the world is land, and the land above it splits into four bands of
// roughly comparable area rather than one band holding everything.
export const SEA = 0.478;
export const SHORE = 0.512;
export const GRASS = 0.566;
export const SCRUB = 0.628;

/** World scale: how many world pixels one unit of noise spans. */
const SCALE = 340;

/**
 * Surface height at a world point.
 *
 * Two terms. A broad continental field decides where land is at all, and a
 * finer field breaks up the coast so the waterline is never a smooth curve —
 * that roughness is most of what separates a contour from a drawn shape.
 * A river channel is then subtracted, which is what lets water cut inland.
 */
export function heightAt(wx, wy, seed = 0) {
  const x = wx / SCALE + seed * 13.7;
  const y = wy / SCALE + seed * 7.1;

  const continent = fbm(x * 0.55, y * 0.55, 4, 0.52);
  const coast = fbm(x * 2.1, y * 2.1, 3, 0.5);
  let h = continent * 0.78 + coast * 0.22;

  // Mountain spine, only where the land is already high.
  const spine = ridge(x * 1.15, y * 1.15, 3);
  h += Math.max(0, h - 0.60) * spine * 0.55;

  // River: a ridged channel cut down through whatever it crosses. Rivers are
  // what make a landmass read as drained rather than moulded.
  const riv = ridge(x * 0.75 + 40.3, y * 0.75 + 11.9, 2);
  const channel = Math.pow(clamp01((riv - 0.86) / 0.14), 1.5);
  h -= channel * 0.16;

  return h;
}

/** Is this world point above water? */
export const isLand = (wx, wy, seed) => heightAt(wx, wy, seed) > SEA;

/**
 * A road, as a signed distance in [0,1] where 1 is on the centreline.
 *
 * Follows a contour rather than a straight line, so it bends with the terrain
 * the way a real road does.
 */
export function roadAt(wx, wy, seed = 0) {
  const x = wx / SCALE + seed * 13.7;
  const y = wy / SCALE + seed * 7.1;
  const wander = (fbm(y * 0.9, 3.1, 3) - 0.5) * 1.5;
  const d = Math.abs(x - 0.5 - wander);
  return clamp01(1 - d / 0.055);
}

/** Which surface band a height falls in. */
export function bandOf(h) {
  if (h < SEA) return 'water';
  if (h < SHORE) return 'shore';
  if (h < GRASS) return 'grass';
  if (h < SCRUB) return 'scrub';
  return 'rock';
}

/**
 * Somewhere to put a building: flat, comfortably above the waterline, and
 * near the road. Buildings go where people can build and reach them, which is
 * why scattering props at random offsets never looked like settlement.
 */
export function buildScore(wx, wy, seed = 0) {
  const h = heightAt(wx, wy, seed);
  if (h < SHORE + 0.012 || h > SCRUB) return 0;
  const e = 26;
  const slope = Math.max(
    Math.abs(heightAt(wx + e, wy, seed) - h),
    Math.abs(heightAt(wx, wy + e, seed) - h));
  const flat = clamp01(1 - slope / 0.055);
  const road = roadAt(wx, wy, seed);
  // Near a road helps, but is not required — coastal settlements exist too.
  return flat * (0.62 + 0.38 * road);
}
