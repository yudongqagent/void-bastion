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
import { AIRFRAME_PARTS } from '../js/game/airframes.js';

const TILE = 256;
const SS = 3;                    // supersample factor
const HI = TILE * SS;
const EXTENT = 1.35;             // local units mapped to the tile half-width
const NOMINAL_RADIUS = 38;       // px a craft typically occupies on screen

const TYPES = Object.keys(AIRFRAME_PARTS);
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
 * Paint, as distinct from material.
 *
 * A single hull tint over the whole craft is why they read as coloured blocks.
 * Real aircraft carry a scheme: a darker dorsal spine, lighter outboard panels,
 * a contrasting nose and tail band, an insignia. This multiplies the material,
 * so plating and panel lines still show through, and the archetype hull tint
 * still applies on top of the result.
 */
function livery(x, y, type) {
  let k = 1;
  // Dorsal shadow line down the spine, and lighter outboard skin.
  const ax = Math.abs(x);
  k *= 0.88 + 0.26 * clamp01(ax / 0.55);
  // Nose and tail bands.
  if (y > 0.62) k *= 1.16;
  if (y < -0.62) k *= 0.84;
  // Wing walkway: a darker strip just outboard of the root.
  if (ax > 0.24 && ax < 0.34) k *= 0.90;

  // Squadron insignia — a roundel on each wing. Small, high contrast, and the
  // single most "built by someone" detail on the airframe.
  const rx = ax - 0.52, ry = y - 0.02;
  const rr = Math.hypot(rx, ry);
  let tint = [k, k, k];
  if (rr < 0.10) {
    const ring = rr > 0.062 && rr < 0.092;
    const core = rr < 0.042;
    if (ring || core) tint = [k * 1.35, k * 0.72, k * 0.55];
    else tint = [k * 1.12, k * 1.10, k * 1.06];
  }
  return tint;
}

// --- bake one craft ------------------------------------------------------------

function bakeCraft(type) {
  const parts = AIRFRAME_PARTS[type];
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
      const liv = livery(lx, ly, type);
      Cr[i] = m.r * k * liv[0]; Cg[i] = m.g * k * liv[1]; Cb[i] = m.b * k * liv[2];
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
  // A blank bake and a solid square are both silent failures.
  const warn = r.coverage < 0.08 ? '  <-- NEARLY EMPTY'
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
