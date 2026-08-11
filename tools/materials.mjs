// The material kit: procedural noise primitives and the sixteen material
// functions built from them.
//
// Lives apart from the atlas writer because there are two consumers. gentex.mjs
// bakes these into tiling atlases for the live renderer; genbake.mjs samples
// the same functions in each craft's own frame, so a baked hull and a tiling
// surface are guaranteed to be the same material rather than two things that
// merely look similar.
//
// Two rules shape all sixteen materials:
//
//   1. Albedo is a DETAIL MULTIPLIER, not a colour. The game tints every
//      surface by hull colour, so a tile that carried its own strong colour
//      would fight that. Tiles sit near 1.0 and vary; only materials that are
//      inherently coloured (foil, rust, hazard stripes) push real chroma.
//   2. Height drives normal AND ambient occlusion AND edge wear. Deriving all
//      three from one field is what stops the detail looking like three
//      unrelated layers of noise stacked on each other.
export const TILE = 256;
export const GRID = 4;
export const SIZE = TILE * GRID;

// --- deterministic noise kit ---------------------------------------------------

/** Integer hash -> [0,1). Cheap, and stable across platforms. */
export function hash2(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

export const smooth = (t) => t * t * (3 - 2 * t);
export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Value noise on an f x f lattice, wrapping at the tile edge.
 *
 * The wrap is the whole point — every lattice lookup is taken modulo f, so the
 * tile is seamless and a uv scale above 1 does not show a grid of joins.
 */
export function noise(x, y, f, seed) {
  const gx = x * f, gy = y * f;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const fx = smooth(gx - x0), fy = smooth(gy - y0);
  const xa = ((x0 % f) + f) % f, ya = ((y0 % f) + f) % f;
  const xb = (xa + 1) % f, yb = (ya + 1) % f;
  return lerp(
    lerp(hash2(xa, ya, seed), hash2(xb, ya, seed), fx),
    lerp(hash2(xa, yb, seed), hash2(xb, yb, seed), fx), fy);
}

export function fbm(x, y, f, octaves, seed, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0, freq = f;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x, y, freq, seed + i * 101) * amp;
    norm += amp;
    amp *= gain;
    freq *= 2;
  }
  return sum / norm;
}

/** Stretched fBm — the basis of brushed metal and grain. */
export function fbmAniso(x, y, fx, fy, octaves, seed) {
  let sum = 0, amp = 1, norm = 0, a = fx, b = fy;
  for (let i = 0; i < octaves; i++) {
    const gx = x * a, gy = y * b;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const tx = smooth(gx - x0), ty = smooth(gy - y0);
    const xa = ((x0 % a) + a) % a, ya = ((y0 % b) + b) % b;
    const xb2 = (xa + 1) % a, yb2 = (ya + 1) % b;
    sum += lerp(lerp(hash2(xa, ya, seed + i * 71), hash2(xb2, ya, seed + i * 71), tx),
      lerp(hash2(xa, yb2, seed + i * 71), hash2(xb2, yb2, seed + i * 71), tx), ty) * amp;
    norm += amp; amp *= 0.5; a *= 2; b *= 2;
  }
  return sum / norm;
}

/** Worley F1 on a wrapping f x f cell grid. Returns distance in cell units. */
export function worley(x, y, f, seed) {
  const gx = x * f, gy = y * f;
  const cx = Math.floor(gx), cy = Math.floor(gy);
  let best = 9;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const ax = cx + i, ay = cy + j;
      const wx = ((ax % f) + f) % f, wy = ((ay % f) + f) % f;
      const px = ax + hash2(wx, wy, seed);
      const py = ay + hash2(wx, wy, seed + 7919);
      const d = Math.hypot(gx - px, gy - py);
      if (d < best) best = d;
    }
  }
  return Math.min(1, best);
}

/**
 * Worley F2-F1 — distance to the CELL BORDER, not to the cell centre.
 *
 * F1 is the wrong tool for cracks and seams: it measures distance to the
 * nearest feature point, which almost never approaches zero, so thresholding it
 * yields a nearly blank mask — which is exactly how ceramic, rock and concrete
 * first came out flat. F2-F1 goes to zero on the boundary between two cells,
 * which is where a seam actually is.
 */
export function worleyEdge(x, y, f, seed) {
  const gx = x * f, gy = y * f;
  const cx = Math.floor(gx), cy = Math.floor(gy);
  let f1 = 9, f2 = 9;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const ax = cx + i, ay = cy + j;
      const wx = ((ax % f) + f) % f, wy = ((ay % f) + f) % f;
      const px = ax + hash2(wx, wy, seed);
      const py = ay + hash2(wx, wy, seed + 7919);
      const d = Math.hypot(gx - px, gy - py);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
  }
  return Math.min(1, f2 - f1);
}

/**
 * Irregular hull plating.
 *
 * A plain grid reads as graph paper. Offsetting every row by a per-row random
 * shift (a running bond, like brickwork) and jittering the column pitch gives
 * the irregular plate layout real aircraft skin has.
 */
export function panels(x, y, nx, ny, seed) {
  const row = Math.floor(y * ny);
  const shift = hash2(row, 0, seed + 31) * 0.7;
  const gx = x * nx + shift;
  const col = Math.floor(gx);
  const fx = gx - col, fy = y * ny - row;
  // Distance to the nearest seam, in tile-fractions.
  const d = Math.min(Math.min(fx, 1 - fx) / nx, Math.min(fy, 1 - fy) / ny);
  return { d, id: hash2(((col % nx) + nx) % nx, row, seed + 17), fx, fy, col, row };
}

/** Distance to the nearest of n random scratches. */
export function scratches(x, y, n, seed, len = 0.5) {
  let best = 1;
  for (let i = 0; i < n; i++) {
    const ax = hash2(i, 0, seed), ay = hash2(i, 1, seed);
    const ang = hash2(i, 2, seed) * Math.PI * 2;
    const l = len * (0.25 + hash2(i, 3, seed));
    const bx = ax + Math.cos(ang) * l, by = ay + Math.sin(ang) * l;
    // Nearest point on the segment, evaluated against the wrapped copy too so
    // scratches crossing the tile edge continue on the far side.
    for (const [ox, oy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const px = x + ox, py = y + oy;
      const vx = bx - ax, vy = by - ay;
      const t = clamp01(((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy + 1e-9));
      const d = Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
      if (d < best) best = d;
    }
  }
  return best;
}

// --- materials -----------------------------------------------------------------
//
// Each returns { r, g, b, h, rough, metal } for a point in tile space [0,1).
// r/g/b are multipliers around 1.0, h is height in [0,1].

const paintedPlate = (x, y, s) => {
  const p = panels(x, y, 4, 6, s);
  const seam = 1 - clamp01(p.d / 0.012);                 // recessed seam line
  const grain = fbm(x, y, 32, 4, s + 3);
  // Rivets on a fixed pitch, hugging the seam they fasten.
  const PITCH = 22;
  const rx = Math.abs(((x * PITCH) % 1) - 0.5);
  const ry = Math.abs(((y * PITCH) % 1) - 0.5);
  const dot = clamp01(1 - Math.hypot(rx, ry) / 0.22);
  const nearSeam = clamp01((0.035 - p.d) / 0.035);
  const rivet = dot * nearSeam * (1 - seam);
  const h = clamp01(0.55 + (p.id - 0.5) * 0.06 + grain * 0.10 - seam * 0.45 + rivet * 0.38);
  const tone = 0.92 + (p.id - 0.5) * 0.10 + grain * 0.07 - seam * 0.16 + rivet * 0.10;
  return { r: tone, g: tone, b: tone * 1.01, h, rough: 0.45 + grain * 0.2, metal: 0.55 };
};

const brushedSteel = (x, y, s) => {
  const streak = fbmAniso(x, y, 128, 6, 4, s);
  const broad = fbm(x, y, 8, 3, s + 5);
  const h = clamp01(0.5 + (streak - 0.5) * 0.22 + (broad - 0.5) * 0.10);
  const tone = 0.88 + streak * 0.20 + broad * 0.06;
  return { r: tone, g: tone * 1.005, b: tone * 1.02, h, rough: 0.18 + streak * 0.16, metal: 1 };
};

const carbonWeave = (x, y, s) => {
  // Over/under twill: alternating cells run warp or weft.
  const n = 32;
  const cx = Math.floor(x * n), cy = Math.floor(y * n);
  const warp = (cx + cy) % 2 === 0;
  const fx = x * n - cx, fy = y * n - cy;
  const along = warp ? fy : fx;
  const across = warp ? fx : fy;
  const bump = Math.sin(along * Math.PI) * (1 - Math.abs(across - 0.5) * 0.7);
  const fib = fbmAniso(x, y, warp ? 8 : 256, warp ? 256 : 8, 2, s + 2);
  const h = clamp01(0.42 + bump * 0.30 + fib * 0.08);
  const tone = 0.62 + bump * 0.30 + fib * 0.10;
  return { r: tone, g: tone, b: tone * 1.06, h, rough: 0.22 + (1 - bump) * 0.2, metal: 0.15 };
};

const wornPlate = (x, y, s) => {
  const base = paintedPlate(x, y, s + 40);
  // Paint fails where the surface is proud and the noise agrees.
  const wearNoise = fbm(x, y, 12, 5, s + 61);
  const chip = clamp01((base.h - 0.52) * 3.5) * clamp01((wearNoise - 0.48) * 5);
  const scr = 1 - clamp01(scratches(x, y, 26, s + 77) / 0.006);
  const primer = 0.72;                                    // dull undercoat
  const tone = lerp(base.r, primer, Math.max(chip * 0.85, scr * 0.5));
  return {
    r: tone * 1.02, g: tone * 0.97, b: tone * 0.93,
    h: clamp01(base.h - chip * 0.06 - scr * 0.05),
    rough: clamp01(base.rough + chip * 0.35 + scr * 0.3),
    metal: lerp(base.metal, 0.9, chip),
  };
};

const ceramicArmour = (x, y, s) => {
  const w = worleyEdge(x, y, 7, s);
  const seam = 1 - clamp01(w / 0.16);
  const grain = fbm(x, y, 48, 3, s + 4);
  // Corners chip away where three plates meet — F2-F1 is smallest there.
  const chip = clamp01((0.05 - w) / 0.05) * clamp01((fbm(x, y, 20, 3, s + 8) - 0.42) * 4);
  const h = clamp01(0.62 - seam * 0.40 + grain * 0.08 - chip * 0.25);
  const tone = 0.95 + grain * 0.08 - seam * 0.20 - chip * 0.18;
  return { r: tone, g: tone * 0.99, b: tone * 0.96, h, rough: 0.55 + grain * 0.2 + chip * 0.2, metal: 0.05 };
};

const militaryCamo = (x, y, s) => {
  // Three-tone disruptive pattern from thresholded low-frequency noise.
  const a = fbm(x, y, 5, 4, s);
  const b = fbm(x, y, 9, 3, s + 21);
  const tone = a > 0.55 ? 1.0 : b > 0.52 ? 0.82 : 0.66;
  const p = panels(x, y, 3, 4, s + 5);
  const seam = 1 - clamp01(p.d / 0.010);
  const grain = fbm(x, y, 40, 3, s + 33);
  const h = clamp01(0.55 + grain * 0.10 - seam * 0.40);
  const t = tone * (0.95 + grain * 0.10) - seam * 0.15;
  return { r: t, g: t * 1.02, b: t * 0.94, h, rough: 0.68 + grain * 0.15, metal: 0.1 };
};

const oxidisedIron = (x, y, s) => {
  const rust = fbm(x, y, 6, 5, s, 0.58);
  const pit = worley(x, y, 40, s + 11);
  const bloom = clamp01((rust - 0.42) * 2.6);
  const pits = clamp01((0.35 - pit) / 0.35) * bloom;
  const h = clamp01(0.55 + (rust - 0.5) * 0.2 - pits * 0.35);
  // Real chroma here: rust is orange-brown regardless of the hull tint.
  const t = 0.85 - pits * 0.25;
  return {
    r: t * (1 + bloom * 0.30), g: t * (1 - bloom * 0.10), b: t * (1 - bloom * 0.42),
    h, rough: 0.62 + bloom * 0.3, metal: 1 - bloom * 0.75,
  };
};

const darkComposite = (x, y, s) => {
  const facet = worley(x, y, 5, s);
  const grain = fbm(x, y, 64, 3, s + 6);
  const edge = 1 - clamp01(worleyEdge(x, y, 5, s) / 0.10);
  const h = clamp01(0.5 + facet * 0.14 + grain * 0.05 - edge * 0.2);
  const tone = 0.55 + facet * 0.16 + grain * 0.08;
  return { r: tone * 0.97, g: tone, b: tone * 1.08, h, rough: 0.34 + grain * 0.14, metal: 0.35 };
};

const canopyGlass = (x, y, s) => {
  // Frame members plus a broad specular sweep across the glazing.
  const p = panels(x, y, 3, 2, s);
  const frame = clamp01((0.020 - p.d) / 0.020);
  const sweep = clamp01(0.5 + Math.sin((x * 1.6 + y * 2.4) * Math.PI) * 0.5);
  const grain = fbm(x, y, 60, 2, s + 3);
  const h = clamp01(0.5 + frame * 0.35 + grain * 0.03);
  const tone = lerp(1.05 + sweep * 0.55, 0.72, frame);
  return { r: tone * 0.92, g: tone * 0.99, b: tone * 1.10, h,
    rough: lerp(0.05, 0.6, frame), metal: lerp(0.2, 0.8, frame) };
};

const engineGrille = (x, y, s) => {
  // Deep louvres — a strong height signal, which is what sells an intake.
  const n = 18;
  const fy = y * n - Math.floor(y * n);
  const slot = smooth(clamp01(1 - Math.abs(fy - 0.5) * 2.4));
  const side = 1 - clamp01(Math.abs(x - 0.5) * 1.6);
  const grain = fbm(x, y, 50, 3, s + 2);
  const h = clamp01(0.30 + slot * 0.62 + grain * 0.06);
  const tone = 0.42 + slot * 0.55 + grain * 0.08 - side * 0.05;
  return { r: tone, g: tone * 0.99, b: tone * 0.97, h, rough: 0.3 + (1 - slot) * 0.35, metal: 0.9 };
};

const thermalFoil = (x, y, s) => {
  // Crumpled sheet: sharp creases from ridged noise.
  const n1 = Math.abs(fbm(x, y, 7, 4, s) - 0.5) * 2;
  const n2 = Math.abs(fbm(x, y, 15, 3, s + 12) - 0.5) * 2;
  const crease = 1 - clamp01(Math.min(n1, n2) * 3.2);
  const h = clamp01(0.5 + crease * 0.34 - n1 * 0.12);
  const tone = 0.80 + crease * 0.45;
  return { r: tone * 1.14, g: tone * 0.94, b: tone * 0.46, h, rough: 0.16 + n2 * 0.2, metal: 1 };
};

const concrete = (x, y, s) => {
  const agg = worley(x, y, 34, s);
  const coarse = fbm(x, y, 10, 5, s + 4);
  const stain = fbm(x, y, 4, 3, s + 15);
  // Exposed aggregate: stones sit PROUD, pinholes sit low.
  const stone = clamp01((0.45 - agg) / 0.45) * clamp01((fbm(x, y, 30, 2, s + 21) - 0.35) * 3);
  const pit = clamp01((0.14 - worleyEdge(x, y, 34, s + 5)) / 0.14) * 0.5;
  const h = clamp01(0.5 + coarse * 0.14 + stone * 0.20 - pit * 0.28);
  const tone = 0.82 + coarse * 0.16 + stone * 0.16 - pit * 0.16 - stain * 0.12;
  return { r: tone, g: tone * 0.995, b: tone * 0.97, h, rough: 0.85 + coarse * 0.1, metal: 0 };
};

const rock = (x, y, s) => {
  const strata = fbmAniso(x, y, 5, 30, 4, s);
  const crack = 1 - clamp01(worleyEdge(x, y, 9, s + 3) / 0.13);
  const detail = fbm(x, y, 40, 4, s + 9);
  const blocky = worley(x, y, 9, s + 3);
  const h = clamp01(0.42 + strata * 0.40 + blocky * 0.16 + detail * 0.10 - crack * 0.55);
  const tone = 0.60 + strata * 0.38 + blocky * 0.14 + detail * 0.12 - crack * 0.30;
  return { r: tone * 1.02, g: tone, b: tone * 0.95, h, rough: 0.88 + detail * 0.1, metal: 0 };
};

const sand = (x, y, s) => {
  // Wind ripples run crosswise, with a slower dune swell underneath.
  const ripple = fbmAniso(x, y, 64, 6, 2, s);
  const dune = fbmAniso(x, y, 5, 3, 3, s + 31);
  const grain = fbm(x, y, 140, 2, s + 7);
  const crest = Math.pow(clamp01(ripple), 1.6);
  const h = clamp01(0.42 + crest * 0.34 + dune * 0.20 + grain * 0.06);
  const tone = 0.80 + crest * 0.30 + dune * 0.14 + grain * 0.08;
  return { r: tone * 1.06, g: tone * 1.0, b: tone * 0.84, h, rough: 0.92, metal: 0 };
};

const scorchedMetal = (x, y, s) => {
  const base = brushedSteel(x, y, s + 55);
  const soot = fbm(x, y, 7, 5, s + 71, 0.6);
  const burn = clamp01((soot - 0.38) * 2.2);
  const blister = worley(x, y, 26, s + 88);
  const blist = clamp01((0.3 - blister) / 0.3) * burn;
  const tone = base.r * (1 - burn * 0.68) - blist * 0.1;
  // Heat tint: the transition ring between clean metal and soot runs blue-violet.
  const heat = clamp01(1 - Math.abs(soot - 0.38) * 11) * 0.22;
  return {
    r: tone * (1 - heat * 0.10), g: tone * (1 + heat * 0.02), b: tone * (1 + heat * 0.26),
    h: clamp01(base.h - blist * 0.2), rough: clamp01(0.3 + burn * 0.55), metal: 1 - burn * 0.4,
  };
};

const hazardStripe = (x, y, s) => {
  const p = panels(x, y, 3, 4, s);
  const seam = 1 - clamp01(p.d / 0.012);
  const band = ((x + y) * 5) % 1;
  const on = band < 0.5 ? 1 : 0;
  const grain = fbm(x, y, 36, 3, s + 4);
  const wear = clamp01((fbm(x, y, 14, 4, s + 19) - 0.5) * 3);
  const t = lerp(on ? 1.25 : 0.5, 0.8, wear * 0.5) * (0.95 + grain * 0.1) - seam * 0.2;
  return {
    r: t * (on ? 1.12 : 0.95), g: t * (on ? 0.98 : 0.95), b: t * (on ? 0.32 : 0.98),
    h: clamp01(0.55 + grain * 0.1 - seam * 0.4), rough: 0.5 + grain * 0.2, metal: 0.4,
  };
};

export const MATERIALS = [
  { name: 'painted-plate', fn: paintedPlate },
  { name: 'brushed-steel', fn: brushedSteel },
  { name: 'carbon-weave', fn: carbonWeave },
  { name: 'worn-plate', fn: wornPlate },
  { name: 'ceramic-armour', fn: ceramicArmour },
  { name: 'military-camo', fn: militaryCamo },
  { name: 'oxidised-iron', fn: oxidisedIron },
  { name: 'dark-composite', fn: darkComposite },
  { name: 'canopy-glass', fn: canopyGlass },
  { name: 'engine-grille', fn: engineGrille },
  { name: 'thermal-foil', fn: thermalFoil },
  { name: 'concrete', fn: concrete },
  { name: 'rock', fn: rock },
  { name: 'sand', fn: sand },
  { name: 'scorched-metal', fn: scorchedMetal },
  { name: 'hazard-stripe', fn: hazardStripe },
];

