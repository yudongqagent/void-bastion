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
import { CRAFT, CRAFT_MATERIAL } from '../js/game/craft.js';

const TILE = 256;
const SS = 2;                    // supersample factor
const HI = TILE * SS;
const EXTENT = 1.35;             // local units mapped to the tile half-width
const NOMINAL_RADIUS = 38;       // px a craft typically occupies on screen

const TYPES = Object.keys(CRAFT);
const GRID = Math.ceil(Math.sqrt(TYPES.length));
const SIZE = TILE * GRID;

// Light in the craft's local frame, matching the renderer's KEY_LIGHT.
const LIGHT = [-0.42, -0.91];
const LIGHT_ELEV = 0.62;

// --- geometry ------------------------------------------------------------------

/** Signed distance to a capsule from a to b with radius r. Negative inside. */
function sdCapsule(px, py, ax, ay, bx, by, r) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const t = clamp01((wx * vx + wy * vy) / (vx * vx + vy * vy + 1e-9));
  return Math.hypot(wx - vx * t, wy - vy * t) - r;
}

/** Regular n-gon, circumradius r. Mirrors the renderer's sdPoly exactly. */
function sdPoly(px, py, r, n, rot) {
  const c = Math.cos(-rot), s = Math.sin(-rot);
  const x = px * c - py * s, y = px * s + py * c;
  const an = Math.PI / n;
  const a = Math.atan2(y, x);
  const k = ((a + an) % (2 * an) + 2 * an) % (2 * an) - an;
  return Math.hypot(x, y) * Math.cos(k) - r * Math.cos(an);
}

function sdBox(px, py, hw, hh) {
  const dx = Math.abs(px) - hw, dy = Math.abs(py) - hh;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
}

/**
 * How high a part sits, and how much its cross-section bulges.
 *
 * Derived from what the part IS rather than hand-authored per part: centreline
 * pieces are spine and fuselage and sit high, outboard pieces are wings and
 * sponsons and sit low. That keeps all 21 recipes working untouched and leaves
 * one function to tune instead of 150 numbers to maintain.
 */
function profileFor(part) {
  // Rings and orbit nodes are effects, not structure — they stay dynamic and
  // have no centre to read.
  if (part.t !== 'bar' && part.t !== 'gon' && part.t !== 'slab') return null;
  const cx = part.t === 'bar'
    ? Math.abs((part.a[0] + part.b[0]) / 2)
    : Math.abs(part.p[0]);
  const central = 1 - Math.min(1, cx / 0.75);
  switch (part.t) {
    case 'bar': {
      const w = part.w;
      // A bar becomes a tube: the rise is proportional to its own thickness.
      return { base: 0.26 + 0.30 * central, rise: Math.min(0.34, w * 1.5) };
    }
    case 'gon':
      // A polygon becomes a blister/dome.
      return { base: 0.28 + 0.26 * central, rise: Math.min(0.40, part.r * 0.85) };
    case 'slab':
      return { base: 0.24 + 0.22 * central, rise: 0.07 };
    default:
      return null;
  }
}

// --- bake one craft ------------------------------------------------------------

function bakeCraft(type) {
  const parts = CRAFT[type];
  const [matLayer, repeatPx] = CRAFT_MATERIAL[type] || [0, 24];
  const material = MATERIALS[matLayer].fn;
  const matSeed = 1000 + matLayer * 137;
  // Plating density that matches how the craft actually appears on screen.
  const matRepeats = (2 * NOMINAL_RADIUS) / repeatPx;

  const N = HI * HI;
  const H = new Float32Array(N);        // height, 0 where uncovered
  const A = new Float32Array(N);        // coverage
  const Cr = new Float32Array(N), Cg = new Float32Array(N), Cb = new Float32Array(N);
  const Ro = new Float32Array(N);       // roughness
  const Em = new Float32Array(N);       // emissive (running lights)

  const toLocal = (i) => (i / HI) * 2 * EXTENT - EXTENT;
  const px2local = (2 * EXTENT) / HI;

  for (let py = 0; py < HI; py++) {
    const ly = toLocal(py + 0.5);
    for (let px = 0; px < HI; px++) {
      const lx = toLocal(px + 0.5);
      const i = py * HI + px;

      let bestH = -1, bestPart = null, bestCov = 0;
      for (const part of parts) {
        const prof = profileFor(part);
        if (!prof) continue;
        let d, u;
        if (part.t === 'bar') {
          d = sdCapsule(lx, ly, part.a[0], part.a[1], part.b[0], part.b[1], part.w);
          u = clamp01((d + part.w) / part.w);          // 0 at axis, 1 at rim
        } else if (part.t === 'gon') {
          d = sdPoly(lx - part.p[0], ly - part.p[1], part.r, part.sides, part.rot || 0);
          u = clamp01(Math.hypot(lx - part.p[0], ly - part.p[1]) / part.r);
        } else {
          d = sdBox(lx - part.p[0], ly - part.p[1], part.hw, part.hh);
          u = clamp01(-d / 0.06);                      // chamfered edge
          u = 1 - u;
        }
        if (d > px2local) continue;
        // Antialiased coverage from the distance field.
        const cov = clamp01(0.5 - d / px2local);
        if (cov <= 0) continue;
        const bulge = Math.sqrt(Math.max(0, 1 - u * u));
        const h = prof.base + prof.rise * bulge;
        if (h > bestH) { bestH = h; bestPart = part; bestCov = cov; }
        if (cov > A[i]) A[i] = cov;
      }

      if (!bestPart) continue;
      H[i] = bestH;

      // Material sampled in the craft's own frame, so plating and panel lines
      // belong to this hull rather than floating over it.
      const mu = ((lx / (2 * EXTENT)) + 0.5) * matRepeats;
      const mv = ((ly / (2 * EXTENT)) + 0.5) * matRepeats;
      const m = material(mu - Math.floor(mu), mv - Math.floor(mv), matSeed);
      const k = bestPart.m || 1;
      Cr[i] = m.r * k; Cg[i] = m.g * k; Cb[i] = m.b * k;
      Ro[i] = m.rough;
    }
  }

  // Running lights sit on top of whatever they are mounted to.
  for (const part of parts) {
    if (part.t !== 'dot') continue;
    const cx = (part.p[0] / (2 * EXTENT) + 0.5) * HI;
    const cy = (part.p[1] / (2 * EXTENT) + 0.5) * HI;
    // Lights read as lamps set into the hull, not as glowing discs bolted on.
    const r = (part.r * 0.62 / (2 * EXTENT)) * HI;
    const r2 = Math.ceil(r) + 2;
    for (let y = Math.max(0, cy - r2 | 0); y < Math.min(HI, cy + r2); y++) {
      for (let x = Math.max(0, cx - r2 | 0); x < Math.min(HI, cx + r2); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const cov = clamp01(r - d + 0.5);
        if (cov <= 0) continue;
        const i = y * HI + x;
        Em[i] = Math.max(Em[i], cov * Math.min(1, (part.m || 1) / 2.6));
        if (cov > A[i]) { A[i] = cov; }
        H[i] = Math.max(H[i], 0.62);
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
