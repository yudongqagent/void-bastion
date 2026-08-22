import { heightAt, roadAt, buildScore, SEA, SHORE, SCRUB }
  from './heightfield.js';
// Scrolling terrain.
//
// The lane used to be empty space with a starfield, which reads as "abstract
// shooter". Flying over actual ground — coastline, islands, airbases, convoy
// lanes — is most of what makes the reference game feel like a place rather
// than a backdrop, and it gives static ground targets somewhere to stand.
//
// Features are generated ahead of the ship, scroll down with the world, and are
// recycled once they leave. Everything is composed from the renderer's five SDF
// primitives; there are still no textures anywhere in this project.

const TAU = Math.PI * 2;

/** Ground palettes per zone id, falling back to open ocean. */
export const GROUND = {
  'outer-reach':    { water: [0.055, 0.090, 0.135], land: [0.26, 0.34, 0.24], sand: [0.52, 0.49, 0.36], surf: [0.45, 0.70, 0.80] },
  'asteroid-belt':  { water: [0.095, 0.075, 0.058], land: [0.38, 0.29, 0.19], sand: [0.56, 0.45, 0.29], surf: [0.62, 0.50, 0.34] },
  'ion-storm':      { water: [0.050, 0.075, 0.130], land: [0.22, 0.28, 0.35], sand: [0.40, 0.45, 0.52], surf: [0.50, 0.72, 1.00] },
  'crimson-nebula': { water: [0.105, 0.055, 0.065], land: [0.33, 0.20, 0.20], sand: [0.52, 0.34, 0.32], surf: [0.78, 0.42, 0.42] },
  'derelict-fleet': { water: [0.052, 0.085, 0.090], land: [0.23, 0.31, 0.29], sand: [0.42, 0.47, 0.42], surf: [0.42, 0.70, 0.65] },
  'void-rift':      { water: [0.072, 0.055, 0.115], land: [0.28, 0.23, 0.38], sand: [0.45, 0.37, 0.56], surf: [0.60, 0.48, 0.88] },
};

import { MAT } from './craft.js';

export function groundFor(id) { return GROUND[id] || GROUND['outer-reach']; }

/**
 * One landmass, base or convoy lane. `y` is the world position of its centre;
 * the game scrolls it and asks for a redraw each frame.
 */
function makeIsland(rng, x, w) {
  const lobes = [];
  const n = 3 + ((rng() * 3) | 0);
  for (let i = 0; i < n; i++) {
    lobes.push({
      dx: (rng() - 0.5) * w * 0.8,
      dy: (rng() - 0.5) * w * 0.65,
      r: w * (0.24 + rng() * 0.24),
      sides: 6 + ((rng() * 3) | 0),
      rot: rng() * TAU,
    });
  }
  // Islands are inhabited: groves and rock outcrops, placed inside the lobes so
  // nothing floats off the coast.
  const props = [];
  for (const l of lobes) {
    const n = 2 + ((rng() * 3) | 0);
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2, d = l.r * 0.55 * rng();
      props.push({
        type: rng() < 0.60 ? 'grove' : 'outcrop',
        dx: l.dx + Math.cos(a) * d, dy: l.dy + Math.sin(a) * d,
        r: Math.min(l.r * 0.26, 11 + rng() * 9), rot: rng() * Math.PI * 2,
      });
    }
    // Signs of habitation: a jetty reaching into the water, a mast on a peak.
    if (rng() < 0.4) {
      const a = rng() * Math.PI * 2;
      props.push({ type: 'pier', dx: l.dx + Math.cos(a) * l.r * 0.95,
        dy: l.dy + Math.sin(a) * l.r * 0.95, r: Math.min(l.r * 0.32, 26), rot: a - Math.PI / 2 });
    }
    if (rng() < 0.28) {
      props.push({ type: 'mast', dx: l.dx + (rng() - 0.5) * l.r * 0.6,
        dy: l.dy + (rng() - 0.5) * l.r * 0.6, r: Math.min(l.r * 0.22, 20), rot: 0 });
    }
    if (rng() < 0.22) {
      props.push({ type: 'depot', dx: l.dx + (rng() - 0.5) * l.r * 0.7,
        dy: l.dy + (rng() - 0.5) * l.r * 0.7, r: Math.min(l.r * 0.26, 24), rot: rng() * 0.6 - 0.3 });
    }
  }
  return { kind: 'island', x, w, lobes, props };
}

/** Airfield furniture: what a base is actually made of. */
function baseProps(rng, w) {
  const out = [];
  // Clamped: structures are real objects at a real size, not a fraction of
  // whatever slab they happen to stand on.
  const put = (type, dx, dy, r, rot = 0) =>
    out.push({ type, dx, dy, r: Math.min(w * r, 34), rot });
  // A base should read as a working airfield: control, shelter, storage,
  // sensors and clutter, not one shed on a slab.
  put('tower', (rng() - 0.5) * w * 0.5, w * 0.30, 0.13);
  put('hangar', -w * (0.20 + rng() * 0.12), -w * 0.10, 0.17, rng() * 0.3 - 0.15);
  if (rng() < 0.8) put('hangar', w * (0.22 + rng() * 0.10), -w * 0.22, 0.15, rng() * 0.3 - 0.15);
  if (rng() < 0.55) put('hangar', -w * (0.30 + rng() * 0.10), w * 0.34, 0.13, rng() * 0.4 - 0.2);
  if (rng() < 0.75) put('radar', w * (rng() - 0.5) * 0.5, -w * 0.34, 0.10);
  if (rng() < 0.7) put('silo', -w * (0.26 + rng() * 0.1), w * 0.22, 0.12);
  if (rng() < 0.7) put('containers', w * (0.24 + rng() * 0.1), w * 0.16, 0.11);
  if (rng() < 0.6) put('bunker', w * (rng() - 0.5) * 0.6, -w * 0.40, 0.10);
  if (rng() < 0.65) put('depot', w * (0.28 + rng() * 0.12), -w * 0.02, 0.13);
  if (rng() < 0.6) put('mast', w * (rng() - 0.5) * 0.7, w * 0.42, 0.11);
  if (rng() < 0.5) put('containers', -w * (0.34 + rng() * 0.08), -w * 0.30, 0.09,
    rng() * 0.6 - 0.3);
  if (rng() < 0.45) put('grove', w * (rng() - 0.5) * 0.9, -w * 0.46, 0.10);
  return out;
}

function makeBase(rng, x, w) {
  const pads = [];
  const n = 2 + ((rng() * 3) | 0);
  for (let i = 0; i < n; i++) {
    pads.push({
      dx: (rng() - 0.5) * w * 0.7,
      dy: (rng() - 0.5) * w * 0.5,
      w: w * (0.10 + rng() * 0.10),
      h: w * (0.08 + rng() * 0.09),
      rot: (rng() - 0.5) * 0.4,
    });
  }
  return {
    kind: 'base', x, w, pads, props: baseProps(rng, w),
    runway: { dx: (rng() - 0.5) * w * 0.3, len: w * (0.5 + rng() * 0.4), rot: (rng() - 0.5) * 0.5 },
  };
}

function makeConvoy(rng, x, w) {
  const ships = [];
  const n = 2 + ((rng() * 2) | 0);
  for (let i = 0; i < n; i++) {
    ships.push({ dx: (rng() - 0.5) * w * 0.8, dy: i * w * 0.42 - w * 0.3, len: w * 0.24, rot: (rng() - 0.5) * 0.25 });
  }
  // Deck cargo, so a convoy reads as freight rather than as grey bars.
  const props = [];
  for (const sh of ships) {
    if (rng() < 0.8) props.push({ type: 'containers', dx: sh.dx, dy: sh.dy + sh.len * 0.12,
      r: sh.len * 0.30, rot: sh.rot });
    if (rng() < 0.4) props.push({ type: 'crane', dx: sh.dx, dy: sh.dy - sh.len * 0.35,
      r: sh.len * 0.26, rot: sh.rot });
  }
  return { kind: 'convoy', x, w, ships, props };
}

function makeReef(rng, x, w) {
  const rocks = [];
  const n = 4 + ((rng() * 5) | 0);
  for (let i = 0; i < n; i++) {
    rocks.push({
      dx: (rng() - 0.5) * w, dy: (rng() - 0.5) * w * 0.8,
      r: w * (0.05 + rng() * 0.09), sides: 5 + ((rng() * 3) | 0), rot: rng() * TAU,
    });
  }
  const props = rocks.filter(() => rng() < 0.5).map((rk) => ({
    type: 'outcrop', dx: rk.dx, dy: rk.dy, r: rk.r * 0.8, rot: rng() * Math.PI * 2,
  }));
  return { kind: 'reef', x, w, rocks, props };
}

// Islands, reefs and bases are the heightfield's job now; only ships on open
// water are still a discrete object.
const BUILDERS = [makeConvoy];

export class Terrain {
  constructor() {
    this.features = [];
    this.nextY = 0;
    this.seed = 1;
  }

  rng() {
    // Small deterministic PRNG so a given run's coastline is stable frame to
    // frame; Math.random here would make features shimmer as they scroll.
    this.seed = (this.seed * 1664525 + 1013904223) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  reset(y0) {
    this.features.length = 0;
    this.nextY = y0 - 200;
    // worldY = screenY - originY. Everything the field decides is keyed off
    // world space, so nothing shimmers as the lane scrolls under it.
    this.originY = 0;
    this.fieldSeed = this.fieldSeed || 0;
  }

  /** Keep the lane ahead populated and drop anything that has scrolled past. */
  update(dt, scrollPx, x0, x1, y0, y1) {
    this.originY += scrollPx;
    this.x0v = x0; this.x1v = x1;
    for (const f of this.features) f.y += scrollPx;

    while (this.features.length && this.features[0].y - this.features[0].w > y1 + 260) {
      this.features.shift();
    }

    const width = x1 - x0;
    while (this.nextY > y0 - 1400) {
      // Scaled off the NARROW side of the lane, and capped. At 0.30-0.85 of a
      // phone's 390px width, plus lobes reaching 0.6w beyond centre, a single
      // island covered the entire screen and the game stopped reading as
      // flying over an archipelago and started reading as flying over land.
      const w = Math.min(width, 420) * (0.22 + this.rng() * 0.34);
      const build = BUILDERS[(this.rng() * BUILDERS.length) | 0];
      const f = build(this.rng.bind(this), x0 + this.rng() * width, w);
      f.y = this.nextY;
      this.features.push(f);
      // Gap scales with the feature so big islands are not stacked on top of
      // each other, and open water still shows between them.
      this.nextY -= w * (0.55 + this.rng() * 0.7) + 60;
    }
    // nextY moves up (negative) as we add; shift it down with the world too.
    this.nextY += scrollPx;
  }

  /** Flat, lit deck positions a ground unit can be placed on. */
  /**
   * Flat land a ground unit can be placed on, found by asking the field
   * instead of reading a list of feature decks.
   */
  anchorPoints(y0, y1) {
    const out = [];
    const oy = this.originY, seed = this.fieldSeed;
    const STEP = 26;
    for (let sy = y0; sy < y1; sy += STEP) {
      for (let x = this.x0v + 24; x < this.x1v - 24; x += STEP) {
        // A gun emplacement needs solid ground, not the flat, road-served plot a
        // hangar wants. Measured across 20km of world: buildScore > 0.5 leaves
        // 35% of spawn bands with nowhere at all to put a turret, where simply
        // being above the shoreline covers 88%.
        if (heightAt(x, sy - oy, seed) > SHORE + 0.006) {
          out.push({ x, y: sy, kind: 'land' });
        }
      }
    }
    return out;
  }



  /**
   * What lies under a world point: 'water' or 'land'.
   *
   * Circle approximations of each feature — cheap, and only ever called when a
   * piece of wreckage actually lands, never per frame per entity.
   */
  /**
   * What lies under a world point: 'water' or 'land'.
   *
   * One field lookup, and the SAME field the shader draws — the hash matches
   * bit for bit. This used to be a loop of circle approximations over every
   * feature, which was a second, independent description of where the land
   * was, and could disagree with what was on screen.
   */
  surfaceAt(x, y) {
    return heightAt(x, y - this.originY, this.fieldSeed) > SEA ? 'land' : 'water';
  }

  /** Open water: a base plane plus scrolling swell lines. */
  renderWater(R, pal, time, x0, x1, y0, y1, scroll) {
    const w = x1 - x0, h = y1 - y0;
    // Deliberately darker than the palette's nominal water. Craft are muted,
    // low-saturation objects by design; against a bright sea they measured at a
    // contrast ratio of 1.55, which is why they read as "dark on dark". Taking
    // the background down is half the fix — the other half is the rim light on
    // the craft themselves.
    const WATER_DIM = 0.55;
    R.slabLit((x0 + x1) / 2, (y0 + y1) / 2, w / 2, h / 2, 0,
      pal.water[0] * WATER_DIM, pal.water[1] * WATER_DIM, pal.water[2] * WATER_DIM, 1, 0);

    // Caustics: two counter-drifting bands of soft light. The sea was a flat
    // plate with a few swell lines, which is the single biggest reason the
    // lower half of the screen read as empty rather than as water.
    const causticRows = 7;
    for (let i = 0; i < causticRows; i++) {
      const phase = time * 0.13 + i * 1.7;
      const cy = y0 + ((i / causticRows) * h + (scroll * 0.35) % h + h) % h;
      const cx = (x0 + x1) / 2 + Math.sin(phase) * w * 0.30;
      R.glow(cx, cy, w * 0.42, pal.surf[0], pal.surf[1], pal.surf[2],
        0.030 + Math.sin(phase * 1.7) * 0.012, 2.8);
    }
    // Swell: long faint lines drifting down at the world's speed.
    const spacing = 78;
    const off = (scroll % spacing + spacing) % spacing;
    for (let y = y0 - spacing + off; y < y1 + spacing; y += spacing) {
      const wob = Math.sin((y + scroll) * 0.02 + time * 0.6) * 10;
      R.beam(x0 - 20, y + wob, x1 + 20, y + wob * 0.6, 1.1,
        pal.surf[0], pal.surf[1], pal.surf[2], 0.07, 0.9);
    }

    // Whitecaps: short bright dashes on the swell crests. Cheap, and it is what
    // makes the surface read as moving water rather than a scrolling gradient.
    // Seeded from a stable WORLD band index, not from the screen y.
    //
    // Seeding from y was a real bug: y scrolls every frame, so each cap's
    // horizontal position was re-randomised 60 times a second and the sea was
    // covered in flickering white dashes. Anything scattered over scrolling
    // terrain has to be keyed to a coordinate that does not move with it.
    const capSpacing = 156;
    const drift = scroll * 1.15;
    const firstBand = Math.floor((y0 - drift) / capSpacing) - 1;
    const lastBand = Math.ceil((y1 - drift) / capSpacing) + 1;
    for (let b = firstBand; b <= lastBand; b++) {
      const y = b * capSpacing + drift;
      for (let k = 0; k < 3; k++) {
        const seed = Math.sin(b * 12.9898 + k * 78.233) * 43758.5453;
        const fx = seed - Math.floor(seed);
        const cx = x0 + fx * w;
        const wob = Math.sin((y + scroll) * 0.02 + time * 0.6) * 10;
        R.beam(cx - 9, y + wob, cx + 9, y + wob, 1.0,
          pal.surf[0] * 1.45, pal.surf[1] * 1.45, pal.surf[2] * 1.45, 0.13, 0.85);
      }
    }
  }

  /**
   * Cloud shadows crossing the map.
   *
   * Drawn ABOVE the terrain and below the craft, at a different scroll rate
   * from everything else, so the world gains a layer it did not have. This is
   * the cheapest parallax available — no new geometry, just soft dark ellipses
   * moving at their own speed — and it does more for depth than anything else
   * of comparable cost.
   */
  renderCloudShadows(R, time, x0, x1, y0, y1, scroll) {
    const w = x1 - x0, h = y1 - y0;
    const span = h * 1.9;
    for (let i = 0; i < 5; i++) {
      const seed = i * 7.13;
      const drift = (scroll * 0.55 + i * span * 0.37) % span;
      const cy = y0 - h * 0.4 + ((drift % span) + span) % span;
      const cx = x0 + (0.5 + Math.sin(seed) * 0.42) * w + Math.sin(time * 0.05 + seed) * w * 0.06;
      const r = w * (0.34 + (Math.sin(seed * 2.1) * 0.5 + 0.5) * 0.30);
      R.glow(cx, cy, r, 0.0, 0.0, 0.02, 0.16, 2.2);
      R.glow(cx + r * 0.42, cy + r * 0.22, r * 0.62, 0.0, 0.0, 0.02, 0.12, 2.2);
    }
  }

  /**
   * Settlements.
   *
   * Placed where the FIELD says a building could stand — flat, above the shore,
   * near the road — and clustered per plot, rather than sprinkled at random
   * offsets from a feature centre. One deterministic hash per plot decides
   * everything about it, so a village is identical every time it scrolls back
   * into view.
   */
  renderSettlements(R, x0, x1, y0, y1, layerOf) {
    if (!layerOf) return;
    const PLOT = 104;
    const seed = this.fieldSeed;
    const oy = this.originY;
    const KINDS = ['hangar', 'depot', 'silo', 'containers', 'bunker', 'tower',
      'radar', 'mast', 'grove', 'grove', 'grove', 'outcrop'];

    const cy0 = Math.floor((y0 - oy - PLOT) / PLOT);
    const cy1 = Math.ceil((y1 - oy + PLOT) / PLOT);
    const cx0 = Math.floor((x0 - PLOT) / PLOT);
    const cx1 = Math.ceil((x1 + PLOT) / PLOT);

    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        let hsh = (Math.imul(cx, 374761393) + Math.imul(cy, 668265263)
          + Math.imul(seed, 15485863)) | 0;
        hsh = Math.imul(hsh ^ (hsh >>> 13), 1274126177);
        const rnd = (n) => {
          hsh = Math.imul(hsh ^ (hsh >>> 15), 2246822519);
          return ((hsh >>> 0) / 4294967296) * n;
        };
        const n = 1 + Math.floor(rnd(3.6));
        for (let i = 0; i < n; i++) {
          const wx = cx * PLOT + rnd(PLOT);
          const wy = cy * PLOT + rnd(PLOT);
          const type = KINDS[Math.floor(rnd(KINDS.length)) % KINDS.length];
          const rr = 10 + rnd(11);
          // Vegetation will grow on rougher ground than a hangar will stand on.
          const need = (type === 'grove' || type === 'outcrop') ? 0.28 : 0.58;
          if (buildScore(wx, wy, seed) < need) continue;
          const layer = layerOf(type);
          if (layer < 0) continue;
          const sy = wy + oy;
          if (sy < y0 - 70 || sy > y1 + 70) continue;
          R.craftShadow(wx + rr * 0.28, sy + rr * 0.22, rr * 1.35, 0, layer, 0.32);
          R.craft(wx, sy, rr * 1.35, 0, layer, 0.40, 0.40, 0.40, 1, [0.44, 0.40, 0.30]);
        }
      }
    }
  }

  render(R, pal, time, y0, y1, layerOf = null) {
    const x0 = this.x0v, x1 = this.x1v;

    // The land: ONE quad. Everything about the coast — its shape, its
    // antialiasing, its surf, its relief — is resolved per pixel inside it.
    R.terrainPal.sand = [pal.sand[0] * 1.15, pal.sand[1] * 1.05, pal.sand[2] * 0.78];
    R.terrainPal.grass = [pal.land[0] * 0.85, pal.land[1] * 1.20, pal.land[2] * 0.68];
    R.terrainPal.scrub = [pal.land[0] * 0.62, pal.land[1] * 0.90, pal.land[2] * 0.56];
    R.terrainPal.rock = [pal.land[0] * 1.18, pal.land[1] * 1.16, pal.land[2] * 1.20];
    R.terrainPal.surf = [pal.surf[0] * 0.85, pal.surf[1] * 0.95, pal.surf[2] * 1.05];
    R.terrain((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2 + 4, (y1 - y0) / 2 + 4,
      this.originY, this.fieldSeed);

    this.renderSettlements(R, x0, x1, y0, y1, layerOf);

    // Convoys are the one feature still living on open water.
    for (const f of this.features) {
      if (f.kind !== 'convoy') continue;
      if (f.y + f.w < y0 - 40 || f.y - f.w > y1 + 40) continue;
      for (const sh of f.ships) {
        const x = f.x + sh.dx, y = f.y + sh.dy;
        R.glow(x, y, sh.len * 1.5, pal.surf[0], pal.surf[1], pal.surf[2], 0.16, 2.2);
        R.slabLit(x, y, sh.len, sh.len * 0.24, Math.PI / 2 + sh.rot,
          0.26, 0.28, 0.30, 1, 0.8, MAT.HULL_SEA, 22);
        R.slabLit(x, y - sh.len * 0.15, sh.len * 0.3, sh.len * 0.16,
          Math.PI / 2 + sh.rot, 0.38, 0.40, 0.42, 1, 0.7);
      }
      if (layerOf && f.props) {
        for (const pr of f.props) {
          const layer = layerOf(pr.type);
          if (layer < 0) continue;
          const px = f.x + pr.dx, py = f.y + pr.dy;
          R.craftShadow(px + pr.r * 0.28, py + pr.r * 0.22, pr.r * 1.35, pr.rot, layer, 0.34);
          R.craft(px, py, pr.r * 1.35, pr.rot, layer, 0.40, 0.40, 0.40, 1, [0.44, 0.40, 0.30]);
        }
      }
    }

  }
}
