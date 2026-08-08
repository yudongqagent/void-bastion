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
      dx: (rng() - 0.5) * w * 0.9,
      dy: (rng() - 0.5) * w * 0.7,
      r: w * (0.28 + rng() * 0.32),
      sides: 6 + ((rng() * 3) | 0),
      rot: rng() * TAU,
    });
  }
  return { kind: 'island', x, w, lobes };
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
    kind: 'base', x, w, pads,
    runway: { dx: (rng() - 0.5) * w * 0.3, len: w * (0.5 + rng() * 0.4), rot: (rng() - 0.5) * 0.5 },
  };
}

function makeConvoy(rng, x, w) {
  const ships = [];
  const n = 2 + ((rng() * 2) | 0);
  for (let i = 0; i < n; i++) {
    ships.push({ dx: (rng() - 0.5) * w * 0.8, dy: i * w * 0.42 - w * 0.3, len: w * 0.24, rot: (rng() - 0.5) * 0.25 });
  }
  return { kind: 'convoy', x, w, ships };
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
  return { kind: 'reef', x, w, rocks };
}

const BUILDERS = [makeIsland, makeIsland, makeBase, makeConvoy, makeReef];

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
  }

  /** Keep the lane ahead populated and drop anything that has scrolled past. */
  update(dt, scrollPx, x0, x1, y0, y1) {
    for (const f of this.features) f.y += scrollPx;

    while (this.features.length && this.features[0].y - this.features[0].w > y1 + 260) {
      this.features.shift();
    }

    const width = x1 - x0;
    while (this.nextY > y0 - 1400) {
      const w = width * (0.30 + this.rng() * 0.55);
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
  anchorPoints(y0, y1) {
    const out = [];
    for (const f of this.features) {
      if (f.y < y0 - 120 || f.y > y1) continue;
      if (f.kind === 'base') {
        for (const p of f.pads) out.push({ x: f.x + p.dx, y: f.y + p.dy, kind: 'base' });
      } else if (f.kind === 'island') {
        for (const l of f.lobes) out.push({ x: f.x + l.dx, y: f.y + l.dy, kind: 'land' });
      } else if (f.kind === 'convoy') {
        for (const sh of f.ships) out.push({ x: f.x + sh.dx, y: f.y + sh.dy, kind: 'sea' });
      }
    }
    return out;
  }

  /** Open water: a base plane plus scrolling swell lines. */
  renderWater(R, pal, time, x0, x1, y0, y1, scroll) {
    const w = x1 - x0, h = y1 - y0;
    R.slabLit((x0 + x1) / 2, (y0 + y1) / 2, w / 2, h / 2, 0,
      pal.water[0], pal.water[1], pal.water[2], 1, 0);
    // Swell: long faint lines drifting down at the world's speed.
    const spacing = 78;
    const off = (scroll % spacing + spacing) % spacing;
    for (let y = y0 - spacing + off; y < y1 + spacing; y += spacing) {
      const wob = Math.sin((y + scroll) * 0.02 + time * 0.6) * 10;
      R.beam(x0 - 20, y + wob, x1 + 20, y + wob * 0.6, 1.1,
        pal.surf[0], pal.surf[1], pal.surf[2], 0.07, 0.9);
    }
  }

  render(R, pal, time, y0, y1) {
    for (const f of this.features) {
      // Off-screen features are still in the list waiting to scroll in; drawing
      // them is pure overdraw on the most fill-heavy shapes in the game.
      if (f.y + f.w < y0 - 40 || f.y - f.w > y1 + 40) continue;
      switch (f.kind) {
        case 'island': {
          for (const l of f.lobes) {
            const x = f.x + l.dx, y = f.y + l.dy;
            // Surf ring, beach, then the land plate on top.
            R.poly(x, y, l.r * 1.16, l.sides, l.rot, pal.surf[0], pal.surf[1], pal.surf[2], 0.22);
            R.polyLit(x, y, l.r * 1.05, l.sides, l.rot, pal.sand[0], pal.sand[1], pal.sand[2], 0.9, 0.5);
            R.polyLit(x, y, l.r * 0.82, l.sides, l.rot + 0.3, pal.land[0], pal.land[1], pal.land[2], 1, 0.75);
          }
          break;
        }
        case 'base': {
          const rw = f.runway;
          const rx = f.x + rw.dx, ry = f.y;
          R.polyLit(f.x, f.y, f.w * 0.62, 7, 0.4, pal.land[0], pal.land[1], pal.land[2], 1, 0.6);
          R.slabLit(rx, ry, rw.len * 0.5, f.w * 0.055, rw.rot, 0.20, 0.21, 0.23, 1, 0.4);
          // Centreline dashes read as a runway rather than a grey bar.
          for (let i = -3; i <= 3; i++) {
            const t = i / 7;
            R.slabLit(rx + Math.cos(rw.rot) * rw.len * t, ry + Math.sin(rw.rot) * rw.len * t,
              rw.len * 0.035, f.w * 0.008, rw.rot, 0.7, 0.7, 0.62, 0.8, 0);
          }
          for (const p of f.pads) {
            R.slabLit(f.x + p.dx, f.y + p.dy, p.w, p.h, p.rot, 0.30, 0.32, 0.31, 1, 0.85);
            R.slabLit(f.x + p.dx, f.y + p.dy - p.h * 0.45, p.w * 0.8, p.h * 0.25, p.rot,
              0.42, 0.44, 0.42, 1, 0.6);
          }
          break;
        }
        case 'convoy': {
          for (const sh of f.ships) {
            const x = f.x + sh.dx, y = f.y + sh.dy;
            R.glow(x, y, sh.len * 1.5, pal.surf[0], pal.surf[1], pal.surf[2], 0.16, 2.2);
            R.slabLit(x, y, sh.len, sh.len * 0.24, Math.PI / 2 + sh.rot, 0.26, 0.28, 0.30, 1, 0.8);
            R.slabLit(x, y - sh.len * 0.15, sh.len * 0.3, sh.len * 0.16, Math.PI / 2 + sh.rot,
              0.38, 0.40, 0.42, 1, 0.7);
          }
          break;
        }
        default: {
          for (const rk of f.rocks) {
            const x = f.x + rk.dx, y = f.y + rk.dy;
            R.poly(x, y, rk.r * 1.3, rk.sides, rk.rot, pal.surf[0], pal.surf[1], pal.surf[2], 0.18);
            R.polyLit(x, y, rk.r, rk.sides, rk.rot, pal.land[0] * 1.1, pal.land[1] * 1.1, pal.land[2] * 1.1, 1, 0.8);
          }
          break;
        }
      }
    }
  }
}
