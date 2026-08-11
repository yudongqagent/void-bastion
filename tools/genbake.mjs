// Craft sprite baker for VOID BASTION.
//
//   node tools/genbake.mjs           write tex/craft*.png
//   node tools/genbake.mjs --check   regenerate and diff against what is committed
//
// Renders every craft class offline from the SAME recipes the live renderer and
// the wreckage system use, into two texture-array atlases:
//
//   tex/craft_albedo.png    RGB albedo x AO x contact shadow, A coverage
//   tex/craft_surface.png   RG tangent normal, B roughness, A emissive
//
// The point is the two things a live 2D renderer structurally cannot do:
// ambient occlusion and contact shadows both need to know about parts OTHER
// than the one being drawn. Drawing primitives additively in one plane makes
// overlaps brighter; in reality a wing crossing a fuselage makes it darker.
// Baking is how Sky Force Reloaded gets its look, via pre-rendered 3D, and it
// is the only way to get it here.
//
// The NORMAL is baked, not the final shade, so craft still light dynamically at
// runtime — the highlight sweeps as they bank instead of being frozen in.
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { encodePNG, decodePNG } from './png.mjs';
import { MATERIALS, clamp01 } from './materials.mjs';
import { CRAFT_MATERIAL } from '../js/game/craft.js';
import { AIRFRAME_PARTS, STRUCTURE_PARTS } from '../js/game/airframes.js';

const TILE = 256;
const SS = 3;                    // supersample factor
const HI = TILE * SS;
const EXTENT = 1.35;             // local units mapped to the tile half-width
const NOMINAL_RADIUS = 38;       // px a craft typically occupies on screen

// Structures ride in the same atlas as the craft: a hangar on an island should
// be lit and occluded exactly the way an aircraft is, and sharing the pipeline
// is the only way to guarantee that rather than hope for it.
const ALL_PARTS = { ...AIRFRAME_PARTS, ...STRUCTURE_PARTS };
const TYPES = Object.keys(ALL_PARTS);
const GRID = Math.ceil(Math.sqrt(TYPES.length));
const SIZE = TILE * GRID;

// Light in the craft's local frame, matching the renderer's KEY_LIGHT.
const LIGHT = [-0.42, -0.91];
const LIGHT_ELEV = 0.62;

// --- geometry ------------------------------------------------------------------
//
// Every primitive answers the same question: for a point in the craft's local
// frame, how far outside am I (negative inside), and how high is the surface
// here? The height profile is what gives the bake real volume — an extruded
// outline reads flat no matter how good the shading on top of it is.

const CANOPY_LAYER = 8;     // canopy glass, in MATERIALS order
const SCORCH_LAYER = 14;    // scorched metal, used around nozzles

function sdSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const t = clamp01((wx * vx + wy * vy) / (vx * vx + vy * vy + 1e-9));
  return { d: Math.hypot(wx - vx * t, wy - vy * t), t };
}

function sdBox(px, py, hw, hh) {
  const dx = Math.abs(px) - hw, dy = Math.abs(py) - hh;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
}

/**
 * Signed distance to a convex polygon. Negative inside.
 *
 * Winding-agnostic on purpose: mirroring a wing reverses its winding, and a
 * fixed-sign inside test then rejects every point on the mirrored side. That
 * produced craft with a full wing on the left and nothing on the right.
 */
function sdConvex(px, py, pts) {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const sign = area >= 0 ? 1 : -1;
  let inside = true, best = 1e9;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    if (((px - a[0]) * ey - (py - a[1]) * ex) * sign > 0) inside = false;
    best = Math.min(best, sdSeg(px, py, a[0], a[1], b[0], b[1]).d);
  }
  return inside ? -best : best;
}

/** The four corners of a wing, in the order the planform describes them. */
function wingPts(w) {
  const xr = w.x0, xt = w.x0 + w.span;
  return [
    [xr, w.y + w.root / 2],
    [xt, w.y + w.tip / 2 - w.sweep],
    [xt, w.y - w.tip / 2 - w.sweep],
    [xr, w.y - w.root / 2],
  ];
}

/**
 * Evaluate one part.
 *
 * @returns {?{d:number, h:number, mat:number, em:number}} d is signed distance,
 *   h the surface height, mat an optional material override, em emissive.
 */
function evalPart(part, x, y) {
  switch (part.t) {
    case 'loft': {
      const st = part.st;
      const yHi = st[0][0], yLo = st[st.length - 1][0];
      if (y > yHi || y < yLo) {
        // Cap the ends so the nose and tail close rather than shearing off.
        const yc = y > yHi ? yHi : yLo;
        const s = y > yHi ? st[0] : st[st.length - 1];
        const d = Math.hypot(x, y - yc) - s[1] * 0.6;
        if (d > 0) return null;
        return { d, h: s[2] * 0.5 * Math.sqrt(Math.max(0, 1 - (d / (s[1] + 1e-6)) ** 2)) };
      }
      let i = 0;
      while (i < st.length - 2 && y < st[i + 1][0]) i++;
      const a = st[i], b = st[i + 1];
      const t = (a[0] - y) / (a[0] - b[0] + 1e-9);
      const w = a[1] + (b[1] - a[1]) * t;
      const hh = a[2] + (b[2] - a[2]) * t;
      const d = Math.abs(x) - w;
      if (d > 0) return null;
      const u = clamp01(Math.abs(x) / (w + 1e-6));
      return { d, h: hh * Math.sqrt(Math.max(0, 1 - u * u)) };
    }
    case 'wing': {
      const pts = wingPts(part);
      const d = sdConvex(x, y, pts);
      if (d > 0) return null;
      // Airfoil: thick at the root and just aft of the leading edge, thin at
      // the tip and along the trailing edge.
      const spanT = clamp01(Math.abs(x - part.x0) / (Math.abs(part.span) + 1e-6));
      const chord = part.root + (part.tip - part.root) * spanT;
      const yMid = part.y - part.sweep * spanT;
      const chordT = clamp01((yMid + chord / 2 - y) / (chord + 1e-6));
      const thick = Math.sin(Math.PI * Math.min(1, chordT * 1.7)) * (1 - spanT * 0.65);
      return { d, h: part.h * Math.max(0.18, thick) };
    }
    case 'nacelle': {
      const [cx, cy] = part.p;
      const { d: dd, t } = sdSeg(x, y, cx, cy + part.len / 2, cx, cy - part.len / 2);
      const d = dd - part.r;
      if (d > 0) return null;
      const u = clamp01(dd / part.r);
      let h = part.h * Math.sqrt(Math.max(0, 1 - u * u));
      let em = 0, mat = -1;
      // t runs 0 at the intake to 1 at the nozzle.
      if (part.intake && t < 0.12) h *= 0.45 + t / 0.12 * 0.55;         // recessed lip
      if (part.nozzle && t > 0.86) {
        h *= 0.5 + (1 - t) / 0.14 * 0.5;
        em = clamp01((t - 0.86) / 0.14) * (1 - u * 0.6);
        mat = SCORCH_LAYER;
      }
      return { d, h, em, mat };
    }
    case 'canopy': {
      const [cx, cy] = part.p;
      const u = Math.hypot((x - cx) / part.rx, (y - cy) / part.ry);
      if (u > 1) return null;
      return { d: (u - 1) * part.rx, h: part.h * Math.sqrt(Math.max(0, 1 - u * u)),
        mat: CANOPY_LAYER };
    }
    case 'fin': {
      const [cx, cy] = part.p;
      const pts = [
        [cx - part.hw, cy], [cx + part.hw, cy],
        [cx + part.hw * 0.4 - part.sweep, cy - part.len],
        [cx - part.hw * 0.4 - part.sweep, cy - part.len],
      ];
      const d = sdConvex(x, y, pts);
      if (d > 0) return null;
      const t = clamp01((cy - y) / (part.len + 1e-6));
      return { d, h: part.h * (1 - t * 0.45) };
    }
    case 'pylon': case 'plate': {
      const [cx, cy] = part.p;
      const rot = part.rot || 0;
      const c = Math.cos(-rot), s = Math.sin(-rot);
      const lx = (x - cx) * c - (y - cy) * s, ly = (x - cx) * s + (y - cy) * c;
      const d = sdBox(lx, ly, part.hw, part.hh);
      if (d > 0) return null;
      // Chamfered edge so plates read as slabs with thickness, not as decals.
      return { d, h: part.h * Math.min(1, -d / 0.05 + 0.35) };
    }
    case 'store': {
      const [cx, cy] = part.p;
      const { d: dd, t } = sdSeg(x, y, cx, cy + part.len / 2, cx, cy - part.len / 2);
      // Pointed nose on the ordnance.
      const r = part.r * (t < 0.22 ? 0.35 + (t / 0.22) * 0.65 : 1);
      const d = dd - r;
      if (d > 0) return null;
      const u = clamp01(dd / (r + 1e-6));
      return { d, h: part.h * Math.sqrt(Math.max(0, 1 - u * u)) };
    }
    case 'dome': {
      const [cx, cy] = part.p;
      const u = Math.hypot(x - cx, y - cy) / part.r;
      if (u > 1) return null;
      return { d: (u - 1) * part.r, h: part.h * Math.sqrt(Math.max(0, 1 - u * u)) };
    }
    case 'barrel': {
      const [cx, cy] = part.p;
      const a = (part.ang || 0);
      const dx = -Math.sin(a), dy = Math.cos(a);
      const { d: dd } = sdSeg(x, y, cx, cy, cx + dx * part.len, cy + dy * part.len);
      const d = dd - part.r;
      if (d > 0) return null;
      const u = clamp01(dd / part.r);
      return { d, h: part.h * Math.sqrt(Math.max(0, 1 - u * u)) };
    }
    default:
      return null;
  }
}

/**
 * Paint schemes.
 *
 * The craft were one flat tone each, and the cause was not over-saturated hull
 * tints — those are already muted (0.26-0.42) — but that nothing varied HUE
 * across an airframe. The old livery multiplied brightness only, so a craft was
 * one colour at several exposures.
 *
 * Each class now gets a real scheme: an upper surface, lighter outboard panels,
 * a dark dielectric radome at the nose, bare-metal leading edges, and coloured
 * trim. The material still supplies the detail — panel lines, grain, wear — but
 * as a LUMINANCE modulation rather than as the colour itself.
 */
const SCHEMES = {
  ship:       { top: [0.46, 0.52, 0.60], low: [0.74, 0.78, 0.84], trim: [1.25, 0.62, 0.22] },
  drone:      { top: [0.40, 0.43, 0.46], low: [0.64, 0.66, 0.68], trim: [1.10, 0.72, 0.22] },
  darter:     { top: [0.50, 0.44, 0.34], low: [0.78, 0.72, 0.58], trim: [1.15, 0.50, 0.20] },
  mite:       { top: [0.44, 0.46, 0.48], low: [0.66, 0.68, 0.70], trim: [1.05, 0.68, 0.24] },
  wraith:     { top: [0.20, 0.21, 0.26], low: [0.34, 0.36, 0.44], trim: [0.60, 0.55, 1.10] },
  lancer:     { top: [0.38, 0.42, 0.50], low: [0.62, 0.68, 0.76], trim: [1.20, 0.55, 0.30] },
  sniper:     { top: [0.36, 0.40, 0.44], low: [0.60, 0.64, 0.70], trim: [1.15, 0.60, 0.25] },
  splitter:   { top: [0.36, 0.46, 0.38], low: [0.60, 0.72, 0.62], trim: [0.55, 1.20, 0.55] },
  sentinel:   { top: [0.48, 0.44, 0.34], low: [0.76, 0.70, 0.56], trim: [1.20, 0.80, 0.25] },
  brute:      { top: [0.38, 0.38, 0.46], low: [0.62, 0.62, 0.72], trim: [0.85, 0.50, 1.20] },
  gunship:    { top: [0.36, 0.40, 0.30], low: [0.58, 0.62, 0.46], trim: [1.10, 0.85, 0.30] },
  bomber:     { top: [0.42, 0.40, 0.30], low: [0.66, 0.62, 0.46], trim: [1.30, 0.85, 0.20] },
  radial:     { top: [0.32, 0.34, 0.40], low: [0.54, 0.56, 0.66], trim: [1.20, 0.40, 0.35] },
  shielder:   { top: [0.40, 0.46, 0.58], low: [0.66, 0.74, 0.88], trim: [0.45, 0.90, 1.30] },
  warden:     { top: [0.52, 0.46, 0.28], low: [0.82, 0.74, 0.44], trim: [0.40, 1.20, 1.00] },
  dread:      { top: [0.34, 0.36, 0.42], low: [0.56, 0.60, 0.68], trim: [1.25, 0.45, 0.30] },
  juggernaut: { top: [0.36, 0.36, 0.40], low: [0.60, 0.60, 0.66], trim: [0.90, 0.50, 1.20] },
  boss:       { top: [0.34, 0.32, 0.32], low: [0.58, 0.55, 0.52], trim: [1.35, 0.70, 0.15] },
  turret:     { top: [0.42, 0.43, 0.40], low: [0.62, 0.63, 0.58], trim: [1.10, 0.70, 0.25] },
  sam:        { top: [0.40, 0.42, 0.38], low: [0.60, 0.62, 0.56], trim: [1.15, 0.55, 0.25] },
  tank:       { top: [0.34, 0.38, 0.30], low: [0.54, 0.60, 0.46], trim: [1.05, 0.75, 0.28] },
  warship:    { top: [0.40, 0.40, 0.42], low: [0.62, 0.62, 0.64], trim: [1.10, 0.60, 0.25] },

  hangar:     { top: [0.46, 0.48, 0.50], low: [0.66, 0.68, 0.70], trim: [1.10, 0.72, 0.22] },
  tower:      { top: [0.56, 0.57, 0.56], low: [0.74, 0.75, 0.74], trim: [1.20, 0.35, 0.25] },
  radar:      { top: [0.60, 0.62, 0.64], low: [0.80, 0.82, 0.84], trim: [1.10, 0.60, 0.25] },
  silo:       { top: [0.62, 0.63, 0.62], low: [0.82, 0.83, 0.82], trim: [1.15, 0.55, 0.20] },
  crane:      { top: [0.70, 0.58, 0.20], low: [0.90, 0.76, 0.28], trim: [0.30, 0.30, 0.32] },
  containers: { top: [0.42, 0.50, 0.56], low: [0.66, 0.74, 0.80], trim: [1.05, 0.60, 0.28] },
  bunker:     { top: [0.44, 0.46, 0.42], low: [0.62, 0.64, 0.58], trim: [0.95, 0.65, 0.28] },
  grove:      { top: [0.20, 0.34, 0.18], low: [0.34, 0.52, 0.26], trim: [0.26, 0.40, 0.20] },
  outcrop:    { top: [0.42, 0.40, 0.36], low: [0.62, 0.59, 0.53], trim: [0.50, 0.47, 0.43] },
};
const DEFAULT_SCHEME = SCHEMES.drone;

/** Paint colour at a point, before the material's detail is applied. */
const STRUCTURE_SET = new Set(['hangar', 'tower', 'radar', 'silo', 'crane',
  'containers', 'bunker', 'grove', 'outcrop']);

function paintAt(x, y, type) {
  const sc = SCHEMES[type] || DEFAULT_SCHEME;
  const ax = Math.abs(x);
  if (STRUCTURE_SET.has(type)) {
    // Buildings get the two-tone and nothing else — no radome, no spine stripe,
    // and emphatically no squadron roundel on a fuel tank.
    const t = clamp01((ax - 0.08) / 0.46);
    return [sc.top[0] + (sc.low[0] - sc.top[0]) * t,
      sc.top[1] + (sc.low[1] - sc.top[1]) * t,
      sc.top[2] + (sc.low[2] - sc.top[2]) * t];
  }

  // Upper surfaces dark, outboard skin light — the standard two-tone that makes
  // an airframe read as having a top and a side.
  const t = clamp01((ax - 0.10) / 0.42);
  let r = sc.top[0] + (sc.low[0] - sc.top[0]) * t;
  let g = sc.top[1] + (sc.low[1] - sc.top[1]) * t;
  let b = sc.top[2] + (sc.low[2] - sc.top[2]) * t;

  // Dark dielectric radome over the nose.
  if (y > 0.74) {
    const k = clamp01((y - 0.74) / 0.30);
    r = r * (1 - k) + 0.20 * k; g = g * (1 - k) + 0.21 * k; b = b * (1 - k) + 0.24 * k;
  }
  // Bare metal around the exhaust, heat-stained.
  if (y < -0.56) {
    const k = clamp01((-0.56 - y) / 0.36);
    r = r * (1 - k) + 0.52 * k; g = g * (1 - k) + 0.50 * k; b = b * (1 - k) + 0.50 * k;
  }
  // Trim stripe along the spine, and a band across the tail.
  if (ax < 0.045) { r = sc.trim[0] * 0.55; g = sc.trim[1] * 0.55; b = sc.trim[2] * 0.55; }
  if (y > -0.50 && y < -0.42) { r = sc.trim[0] * 0.7; g = sc.trim[1] * 0.7; b = sc.trim[2] * 0.7; }
  // Wing walkway.
  if (ax > 0.24 && ax < 0.31) { r *= 0.82; g *= 0.82; b *= 0.82; }

  // Squadron roundel on each wing — the single most "built by someone" detail.
  const rr = Math.hypot(ax - 0.52, y - 0.02);
  if (rr < 0.095) {
    if (rr < 0.040) { r = 1.25; g = 0.35; b = 0.28; }
    else if (rr < 0.066) { r = 0.92; g = 0.92; b = 0.94; }
    else { r = 0.30; g = 0.36; b = 0.72; }
  }
  return [r, g, b];
}

// --- bake one craft ------------------------------------------------------------

function bakeCraft(type) {
  const parts = ALL_PARTS[type];
  const [matLayer, repeatPx] = CRAFT_MATERIAL[type] || [0, 24];
  const matSeed = 1000 + matLayer * 137;
  const matRepeats = (2 * NOMINAL_RADIUS) / repeatPx;

  const N = HI * HI;
  const H = new Float32Array(N);
  const A = new Float32Array(N);
  const Cr = new Float32Array(N), Cg = new Float32Array(N), Cb = new Float32Array(N);
  const Ro = new Float32Array(N);
  const Em = new Float32Array(N);

  const toLocal = (i) => (i / HI) * 2 * EXTENT - EXTENT;
  const px2local = (2 * EXTENT) / HI;

  for (let py = 0; py < HI; py++) {
    const ly = toLocal(py + 0.5);
    for (let px = 0; px < HI; px++) {
      const lx = toLocal(px + 0.5);
      const i = py * HI + px;

      // The topmost part at this point wins the surface; coverage is the union.
      let bestH = -1, best = null, bestPart = null, cover = 0;
      for (const part of parts) {
        const r = evalPart(part, lx, ly);
        if (!r) continue;
        const cov = clamp01(0.5 - r.d / px2local);
        if (cov <= 0) continue;
        if (cov > cover) cover = cov;
        if (r.h > bestH) { bestH = r.h; best = r; bestPart = part; }
      }
      if (!bestPart) continue;
      A[i] = cover;
      H[i] = bestH;
      if (best.em) Em[i] = best.em;

      const layer = best.mat >= 0 ? best.mat : matLayer;
      const seed = best.mat >= 0 ? 1000 + best.mat * 137 : matSeed;
      const mu = ((lx / (2 * EXTENT)) + 0.5) * matRepeats;
      const mv = ((ly / (2 * EXTENT)) + 0.5) * matRepeats;
      const m = MATERIALS[layer].fn(mu - Math.floor(mu), mv - Math.floor(mv), seed);
      const k = bestPart.m || 1;
      const detail = (m.r + m.g + m.b) / 3;
      const mx = Math.max(m.r, m.g, m.b), mn = Math.min(m.r, m.g, m.b);
      // How much colour the material itself carries. Rust, thermal foil and
      // hazard stripes must keep theirs; plain plate should take the paint.
      const chroma = clamp01((mx - mn) / (mx + 1e-6) * 3.4);
      const paint = paintAt(lx, ly, type);
      Cr[i] = (paint[0] * detail * (1 - chroma) + m.r * chroma) * k;
      Cg[i] = (paint[1] * detail * (1 - chroma) + m.g * chroma) * k;
      Cb[i] = (paint[2] * detail * (1 - chroma) + m.b * chroma) * k;
      Ro[i] = m.rough;
    }
  }

  // Running lights sit on top of whatever they are mounted to.
  for (const part of parts) {
    if (part.t !== 'dot') continue;
    const cx = (part.p[0] / (2 * EXTENT) + 0.5) * HI;
    const cy = (part.p[1] / (2 * EXTENT) + 0.5) * HI;
    const r = (part.r * 0.9 / (2 * EXTENT)) * HI;
    const r2 = Math.ceil(r) + 2;
    for (let y = Math.max(0, cy - r2 | 0); y < Math.min(HI, cy + r2); y++) {
      for (let x = Math.max(0, cx - r2 | 0); x < Math.min(HI, cx + r2); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const cov = clamp01(r - d + 0.5);
        if (cov <= 0) continue;
        const i = y * HI + x;
        Em[i] = Math.max(Em[i], cov * Math.min(1, (part.m || 1) / 2.6));
        if (cov > A[i]) A[i] = cov;
        H[i] = Math.max(H[i], 0.5);
      }
    }
  }

  // --- ambient occlusion: how much of the local neighbourhood rises above us.
  const AO = new Float32Array(N).fill(1);
  const TAPS = 12, MAXR = HI * 0.055;
  for (let y = 0; y < HI; y++) {
    for (let x = 0; x < HI; x++) {
      const i = y * HI + x;
      if (A[i] <= 0.01) continue;
      let occ = 0;
      for (let t = 0; t < TAPS; t++) {
        const ang = (t / TAPS) * Math.PI * 2;
        const rr = MAXR * (0.35 + 0.65 * ((t % 3) / 2));
        const sx = Math.round(x + Math.cos(ang) * rr);
        const sy = Math.round(y + Math.sin(ang) * rr);
        if (sx < 0 || sy < 0 || sx >= HI || sy >= HI) continue;
        const j = sy * HI + sx;
        // Uncovered neighbours are open sky, not occluders.
        if (A[j] <= 0.01) continue;
        occ += Math.max(0, H[j] - H[i]);
      }
      let ao = 1 - (occ / TAPS) * 7.5;
      // Count uncovered neighbours as a soft rim rather than as open sky.
      let open = 0;
      for (let t = 0; t < TAPS; t++) {
        const ang = (t / TAPS) * Math.PI * 2;
        const sx = Math.round(x + Math.cos(ang) * MAXR * 0.6);
        const sy = Math.round(y + Math.sin(ang) * MAXR * 0.6);
        if (sx < 0 || sy < 0 || sx >= HI || sy >= HI || A[sy * HI + sx] <= 0.01) open++;
      }
      ao *= 1 - 0.42 * (open / TAPS);
      AO[i] = clamp01(ao);
    }
  }

  // --- contact shadow: march toward the light and see what blocks us.
  const SH = new Float32Array(N).fill(1);
  const STEPS = 14, STEP = HI * 0.006;
  const lx0 = -LIGHT[0], ly0 = -LIGHT[1];   // toward the light
  for (let y = 0; y < HI; y++) {
    for (let x = 0; x < HI; x++) {
      const i = y * HI + x;
      if (A[i] <= 0.01) continue;
      let shade = 0;
      for (let t = 1; t <= STEPS; t++) {
        const sx = Math.round(x + lx0 * STEP * t);
        const sy = Math.round(y + ly0 * STEP * t);
        if (sx < 0 || sy < 0 || sx >= HI || sy >= HI) break;
        const j = sy * HI + sx;
        if (A[j] <= 0.01) continue;
        // Height the blocker must exceed to cast onto us at this distance.
        const need = H[i] + (STEP * t * px2local) * LIGHT_ELEV;
        if (H[j] > need) { shade = Math.max(shade, Math.min(1, (H[j] - need) * 6)); }
      }
      SH[i] = 1 - shade * 0.55;
    }
  }

  // --- normals from the height field, in local units.
  const Nx = new Float32Array(N), Ny = new Float32Array(N);
  const at = (x, y) => {
    if (x < 0 || y < 0 || x >= HI || y >= HI) return 0;
    return H[y * HI + x];
  };
  for (let y = 0; y < HI; y++) {
    for (let x = 0; x < HI; x++) {
      const i = y * HI + x;
      if (A[i] <= 0.01) continue;
      const dx = (at(x - 1, y) - at(x + 1, y)) / (2 * px2local);
      const dy = (at(x, y - 1) - at(x, y + 1)) / (2 * px2local);
      const inv = 1 / Math.hypot(dx, dy, 1);
      Nx[i] = dx * inv; Ny[i] = dy * inv;
    }
  }

  // --- downsample everything together.
  const out = {
    albedo: new Uint8Array(TILE * TILE * 4),
    surface: new Uint8Array(TILE * TILE * 4),
  };
  let covered = 0;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      let ar = 0, ag = 0, ab = 0, aa = 0, nx = 0, ny = 0, ro = 0, em = 0, wsum = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = (y * SS + sy) * HI + (x * SS + sx);
          const a = A[i];
          aa += a;
          if (a <= 0.001) continue;
          const shade = AO[i] * SH[i];
          ar += Cr[i] * shade * a; ag += Cg[i] * shade * a; ab += Cb[i] * shade * a;
          nx += Nx[i] * a; ny += Ny[i] * a;
          ro += Ro[i] * a; em += Em[i] * a;
          wsum += a;
        }
      }
      const n = SS * SS;
      const alpha = aa / n;
      const w = wsum || 1;
      const o = (y * TILE + x) * 4;
      if (alpha > 0.02) covered++;
      out.albedo[o] = Math.round(clamp01(ar / w / 1.6) * 255);
      out.albedo[o + 1] = Math.round(clamp01(ag / w / 1.6) * 255);
      out.albedo[o + 2] = Math.round(clamp01(ab / w / 1.6) * 255);
      out.albedo[o + 3] = Math.round(clamp01(alpha) * 255);
      out.surface[o] = Math.round((clamp01(nx / w * 0.5 + 0.5)) * 255);
      out.surface[o + 1] = Math.round((clamp01(ny / w * 0.5 + 0.5)) * 255);
      out.surface[o + 2] = Math.round(clamp01(ro / w) * 255);
      out.surface[o + 3] = Math.round(clamp01(em / w) * 255);
    }
  }
  out.coverage = covered / (TILE * TILE);
  return out;
}

// --- assemble ------------------------------------------------------------------

const t0 = Date.now();
const albedo = new Uint8Array(SIZE * SIZE * 4);
const surface = new Uint8Array(SIZE * SIZE * 4);
const report = [];

TYPES.forEach((type, idx) => {
  const tile = bakeCraft(type);
  const ox = (idx % GRID) * TILE, oy = Math.floor(idx / GRID) * TILE;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const src = (y * TILE + x) * 4;
      const dst = ((oy + y) * SIZE + (ox + x)) * 4;
      for (let c = 0; c < 4; c++) {
        albedo[dst + c] = tile.albedo[src + c];
        surface[dst + c] = tile.surface[src + c];
      }
    }
  }
  report.push({ type, layer: idx, coverage: tile.coverage });
});

console.log(`\n  craft bake — ${TYPES.length} classes, ${SIZE}x${SIZE} (${GRID}x${GRID} of ${TILE}px)\n`);
let bad = 0;
for (const r of report) {
  // A blank bake and a solid square are both silent failures. The floor is 5%
  // rather than 8% because thin structures — a crane, a mast — legitimately
  // cover very little of their tile.
  const warn = r.coverage < 0.05 ? '  <-- NEARLY EMPTY'
    : r.coverage > 0.75 ? '  <-- NEARLY SOLID' : '';
  if (warn) bad++;
  console.log(`  ${String(r.layer).padStart(2)}  ${r.type.padEnd(12)} coverage ${(r.coverage * 100).toFixed(1)}%${warn}`);
}

const files = [
  { base: 'craft_albedo', png: encodePNG(albedo, SIZE, SIZE) },
  { base: 'craft_surface', png: encodePNG(surface, SIZE, SIZE) },
];
const CHECK = process.argv.includes('--check');
const dir = new URL('../tex/', import.meta.url);
if (!CHECK && !existsSync(dir)) mkdirSync(dir, { recursive: true });

const manifestPath = new URL('manifest.json', dir);
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
let failed = bad > 0;
for (const f of files) {
  const name = `${f.base}.${createHash('sha256').update(f.png).digest('hex').slice(0, 8)}.png`;
  manifest[f.base] = name;
  const back = decodePNG(f.png);
  if (back.width !== SIZE) throw new Error('bad dimensions for ' + name);
  const path = new URL(name, dir);
  if (CHECK) {
    const existing = existsSync(path) ? readFileSync(path) : null;
    const same = existing && existing.equals(f.png);
    console.log(`\n  ${same ? 'OK  ' : 'DIFF'}  ${name}  ${(f.png.length / 1024).toFixed(0)} KB`);
    if (!same) failed = true;
  } else {
    writeFileSync(path, f.png);
    console.log(`\n  wrote tex/${name}  ${(f.png.length / 1024).toFixed(0)} KB`);
  }
}
manifest.craftGrid = GRID;
manifest.craftOrder = TYPES;
if (!CHECK) {
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log('  updated tex/manifest.json');
}
console.log(`\n  ${Date.now() - t0} ms\n`);
if (failed) process.exit(1);
