// Material atlas generator for VOID BASTION.
//
//   node tools/gentex.mjs           write tex/*.png
//   node tools/gentex.mjs --check   regenerate and diff against what is committed
//
// Writes two 1024x1024 atlases, each a 4x4 grid of 256px tiles, in MATERIALS
// order:
//
//   tex/material.png   RGB albedo detail, A ambient occlusion
//   tex/surface.png    RG tangent normal, B roughness, A metalness
//
// Seeded and deterministic, so regenerating is byte-identical. That matters:
// filenames carry a content hash, and a hash that churned every run would break
// caching for no reason. The materials themselves live in materials.mjs.
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { encodePNG, decodePNG } from './png.mjs';
import { MATERIALS, TILE, GRID, SIZE, clamp01 } from './materials.mjs';

// --- assembly ------------------------------------------------------------------

function build() {
  const albedo = new Uint8Array(SIZE * SIZE * 4);
  const surface = new Uint8Array(SIZE * SIZE * 4);
  const stats = [];

  for (let m = 0; m < MATERIALS.length; m++) {
    const { name, fn } = MATERIALS[m];
    const ox = (m % GRID) * TILE, oy = Math.floor(m / GRID) * TILE;
    const seed = 1000 + m * 137;

    // Evaluate the material once into a scratch buffer, so the normal can be
    // taken from the SAME height field the albedo and AO come from.
    const H = new Float32Array(TILE * TILE);
    const C = new Float32Array(TILE * TILE * 3);
    const RM = new Float32Array(TILE * TILE * 2);
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const i = y * TILE + x;
        const v = fn(x / TILE, y / TILE, seed);
        H[i] = clamp01(v.h);
        C[i * 3] = v.r; C[i * 3 + 1] = v.g; C[i * 3 + 2] = v.b;
        RM[i * 2] = clamp01(v.rough); RM[i * 2 + 1] = clamp01(v.metal);
      }
    }

    let minL = 9, maxL = -9;
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const i = y * TILE + x;
        // Central differences with wrap, matching the tileable noise.
        const l = H[y * TILE + ((x - 1 + TILE) % TILE)];
        const r = H[y * TILE + ((x + 1) % TILE)];
        const u = H[((y - 1 + TILE) % TILE) * TILE + x];
        const d = H[((y + 1) % TILE) * TILE + x];
        const STRENGTH = 3.2;
        let nx = (l - r) * STRENGTH, ny = (u - d) * STRENGTH;
        const nz = 1;
        const inv = 1 / Math.hypot(nx, ny, nz);
        nx *= inv; ny *= inv;

        // Cavity AO: how much lower this point is than its neighbourhood.
        const around = (l + r + u + d) * 0.25;
        const ao = clamp01(1 - Math.max(0, around - H[i]) * 5.5);

        const o = ((oy + y) * SIZE + (ox + x)) * 4;
        const rr = C[i * 3], gg = C[i * 3 + 1], bb = C[i * 3 + 2];
        albedo[o] = Math.round(clamp01(rr / 1.6) * 255);
        albedo[o + 1] = Math.round(clamp01(gg / 1.6) * 255);
        albedo[o + 2] = Math.round(clamp01(bb / 1.6) * 255);
        albedo[o + 3] = Math.round(ao * 255);

        surface[o] = Math.round((nx * 0.5 + 0.5) * 255);
        surface[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        surface[o + 2] = Math.round(RM[i * 2] * 255);
        surface[o + 3] = Math.round(RM[i * 2 + 1] * 255);

        const lum = (rr + gg + bb) / 3;
        if (lum < minL) minL = lum;
        if (lum > maxL) maxL = lum;
      }
    }
    stats.push({ name, index: m, minLum: +minL.toFixed(3), maxLum: +maxL.toFixed(3),
      contrast: +(maxL - minL).toFixed(3) });
  }
  return { albedo, surface, stats };
}

// --- entry ---------------------------------------------------------------------

const t0 = Date.now();
const { albedo, surface, stats } = build();
const albedoPNG = encodePNG(albedo, SIZE, SIZE);
const surfacePNG = encodePNG(surface, SIZE, SIZE);

const shortHash = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 8);
const files = [
  { base: 'material', png: albedoPNG },
  { base: 'surface', png: surfacePNG },
];

const CHECK = process.argv.includes('--check');
const dir = new URL('../tex/', import.meta.url);
if (!CHECK && !existsSync(dir)) mkdirSync(dir, { recursive: true });

console.log('\n  material atlas — ' + MATERIALS.length + ' tiles, ' + SIZE + 'x' + SIZE + '\n');
for (const s of stats) {
  const flag = s.contrast < 0.05 ? '  <-- FLAT, generator bug?' : '';
  console.log(`  ${String(s.index).padStart(2)}  ${s.name.padEnd(16)} contrast ${s.contrast.toFixed(3)}${flag}`);
}

const manifest = {};
let failed = false;
for (const f of files) {
  const hash = shortHash(f.png);
  const name = `${f.base}.${hash}.png`;
  manifest[f.base] = name;
  const path = new URL(name, dir);

  // Round-trip guard: a texture that cannot be decoded back is worse than none.
  const back = decodePNG(f.png);
  if (back.width !== SIZE || back.height !== SIZE) throw new Error('bad dimensions for ' + name);

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

if (!CHECK) {
  writeFileSync(new URL('manifest.json', dir), JSON.stringify(manifest, null, 2) + '\n');
  console.log('  wrote tex/manifest.json');
}
console.log(`\n  ${Date.now() - t0} ms\n`);
if (failed) {
  console.error('  committed atlases do not match the generator — run: node tools/gentex.mjs\n');
  process.exit(1);
}
