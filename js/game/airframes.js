// The airframes.
//
// One entry per craft class, written in the vocabulary from airframe.js. Each
// is 16-28 parts, because that is roughly what it takes to read as an aircraft
// rather than as a shape: nose, canopy, tapered fuselage, wings with distinct
// leading and trailing edges, nacelles with intakes and nozzles, tail surfaces,
// pylons with visible ordnance, and lights.
//
// Two rules learned the hard way:
//
//   1. DETAIL MUST BE IN THE SILHOUETTE. A craft is 16-34px on screen. A notch
//      in a wing, a nozzle that breaks the outline, a fin that stands proud —
//      those survive. Fine surface features do not; they dissolve into grey.
//   2. STATIONS MAKE THE SHAPE. A loft's station list is where the character
//      lives. A long thin nose and a full wing root read as an interceptor; a
//      deep even belly reads as a bomber. Get the stations right and the rest
//      is decoration.
import {
  loft, wing, nacelle, canopy, fin, pylon, store, plate, dome, barrel,
  lamp, orbit, expand,
} from './airframe.js';

// --- shared assemblies ---------------------------------------------------------

/** Twin tailplanes at the tail. */
const tailplane = (y, span, chord, h = 0.09) => [
  wing({ y, root: chord, tip: chord * 0.5, span, x0: 0.10, sweep: 0.14, h, m: 0.9 }),
];

/** A nozzle pair with soot-streaked shrouds. */
const twinNozzle = (x, y, len, r) => [
  nacelle({ p: [x, y], len, r, mirror: true, m: 0.95 }),
];

// --- the player ----------------------------------------------------------------
//
// The one craft on screen the whole time, and the one that was never baked at
// all — it used to be raw beams and an additive plume, which is exactly the
// "glowing colour block" problem in its purest form.
const interceptor = [
  // Sharp nose, full wing root, tapered tail.
  loft([[1.18, 0.045, 0.10], [0.92, 0.10, 0.19], [0.55, 0.17, 0.30],
        [0.12, 0.21, 0.34], [-0.34, 0.17, 0.28], [-0.78, 0.10, 0.17],
        [-1.00, 0.06, 0.10]], { m: 1.0 }),
  canopy({ p: [0, 0.46], rx: 0.115, ry: 0.24, h: 0.46 }),
  // Cranked delta: a kink in the leading edge is the strongest small-size cue.
  wing({ y: 0.10, root: 0.62, tip: 0.20, span: 0.74, x0: 0.17, sweep: 0.40, h: 0.11 }),
  wing({ y: -0.30, root: 0.26, tip: 0.10, span: 0.98, x0: 0.62, sweep: 0.22, h: 0.08, m: 0.92 }),
  ...tailplane(-0.80, 0.40, 0.20),
  fin({ p: [0, -0.72], len: 0.34, hw: 0.045, sweep: 0.18, h: 0.52 }),
  nacelle({ p: [0.235, -0.30], len: 0.42, r: 0.105, mirror: true }),
  pylon({ p: [0.46, -0.02], hw: 0.045, hh: 0.11 }),
  store({ p: [0.46, -0.06], len: 0.30, r: 0.05 }),
  lamp([0, 0.60], 0.055, 2.4),
  lamp([0.80, -0.30], 0.042, 2.0),
  lamp([-0.80, -0.30], 0.042, 2.0),
];

// --- light enemy fighters -------------------------------------------------------

const drone = [
  loft([[1.02, 0.05, 0.10], [0.72, 0.13, 0.22], [0.24, 0.19, 0.31],
        [-0.22, 0.17, 0.27], [-0.70, 0.10, 0.16], [-0.92, 0.055, 0.09]]),
  canopy({ p: [0, 0.34], rx: 0.10, ry: 0.19, h: 0.42 }),
  wing({ y: 0.02, root: 0.50, tip: 0.17, span: 0.86, x0: 0.16, sweep: 0.34, h: 0.10 }),
  ...tailplane(-0.68, 0.34, 0.17),
  fin({ p: [0, -0.60], len: 0.28, hw: 0.04, sweep: 0.14, h: 0.46 }),
  nacelle({ p: [0, -0.62], len: 0.34, r: 0.115 }),
  pylon({ p: [0.40, 0.0], hw: 0.04, hh: 0.09 }),
  store({ p: [0.40, -0.04], len: 0.24 }),
  lamp([0, 0.48], 0.05),
  lamp([0.90, -0.22], 0.036, 1.6),
  lamp([-0.90, -0.22], 0.036, 1.6),
];

const darter = [
  // Needle nose, minimal wing — everything says speed.
  loft([[1.24, 0.030, 0.07], [0.94, 0.075, 0.15], [0.48, 0.135, 0.25],
        [0.0, 0.155, 0.27], [-0.52, 0.115, 0.20], [-0.96, 0.06, 0.11]]),
  canopy({ p: [0, 0.42], rx: 0.085, ry: 0.22, h: 0.40 }),
  wing({ y: -0.10, root: 0.40, tip: 0.10, span: 0.62, x0: 0.13, sweep: 0.46, h: 0.075 }),
  wing({ y: 0.56, root: 0.16, tip: 0.06, span: 0.30, x0: 0.10, sweep: 0.12, h: 0.06, m: 0.9 }),
  fin({ p: [0.10, -0.66], len: 0.26, hw: 0.032, sweep: 0.22, h: 0.44, mirror: true }),
  nacelle({ p: [0, -0.68], len: 0.30, r: 0.095 }),
  lamp([0, 0.56], 0.045, 2.2),
  lamp([0.66, -0.34], 0.03, 1.6),
  lamp([-0.66, -0.34], 0.03, 1.6),
];

const mite = [
  // Tiny, but still an aircraft: it has a nose, a wing and a nozzle.
  loft([[0.86, 0.05, 0.11], [0.42, 0.135, 0.24], [-0.10, 0.155, 0.26],
        [-0.62, 0.09, 0.15]]),
  canopy({ p: [0, 0.24], rx: 0.085, ry: 0.14, h: 0.36 }),
  wing({ y: -0.06, root: 0.36, tip: 0.14, span: 0.60, x0: 0.13, sweep: 0.26, h: 0.08 }),
  fin({ p: [0, -0.46], len: 0.22, hw: 0.035, sweep: 0.12, h: 0.40 }),
  nacelle({ p: [0, -0.52], len: 0.24, r: 0.10 }),
  lamp([0, 0.34], 0.05, 2.2),
];

const wraith = [
  // Faceted flying wing — no fuselage, all planform.
  loft([[0.92, 0.10, 0.13], [0.40, 0.22, 0.24], [-0.16, 0.24, 0.22],
        [-0.62, 0.14, 0.14]], { m: 0.85 }),
  wing({ y: -0.02, root: 0.86, tip: 0.10, span: 1.02, x0: 0.14, sweep: 0.60, h: 0.085, m: 0.8 }),
  canopy({ p: [0, 0.32], rx: 0.10, ry: 0.15, h: 0.30, m: 0.7 }),
  fin({ p: [0.30, -0.34], len: 0.22, hw: 0.03, sweep: 0.26, h: 0.34, mirror: true, m: 0.8 }),
  nacelle({ p: [0.16, -0.50], len: 0.26, r: 0.075, mirror: true, m: 0.85 }),
  lamp([0, 0.20], 0.04, 1.4),
  lamp([0.92, -0.44], 0.03, 1.3),
  lamp([-0.92, -0.44], 0.03, 1.3),
];

const lancer = [
  loft([[1.30, 0.035, 0.08], [1.00, 0.09, 0.17], [0.50, 0.155, 0.28],
        [-0.02, 0.17, 0.29], [-0.56, 0.12, 0.20], [-0.98, 0.065, 0.11]]),
  canopy({ p: [0, 0.40], rx: 0.095, ry: 0.20, h: 0.42 }),
  // A long dorsal rail is this craft's whole identity.
  barrel({ p: [0, 0.55], len: 0.72, r: 0.045, h: 0.50 }),
  wing({ y: -0.12, root: 0.44, tip: 0.13, span: 0.72, x0: 0.15, sweep: 0.42, h: 0.085 }),
  ...tailplane(-0.72, 0.34, 0.16),
  fin({ p: [0, -0.66], len: 0.28, hw: 0.038, sweep: 0.18, h: 0.46 }),
  nacelle({ p: [0.18, -0.60], len: 0.32, r: 0.085, mirror: true }),
  lamp([0, 0.92], 0.04, 2.6),
  lamp([0.76, -0.34], 0.032, 1.6),
  lamp([-0.76, -0.34], 0.032, 1.6),
];

const sniper = [
  loft([[1.32, 0.028, 0.06], [1.02, 0.07, 0.14], [0.46, 0.13, 0.24],
        [-0.08, 0.145, 0.25], [-0.62, 0.10, 0.17], [-1.00, 0.05, 0.09]]),
  barrel({ p: [0, 0.70], len: 0.92, r: 0.038, h: 0.44 }),
  canopy({ p: [0, 0.30], rx: 0.08, ry: 0.17, h: 0.38 }),
  wing({ y: -0.22, root: 0.34, tip: 0.10, span: 0.58, x0: 0.12, sweep: 0.40, h: 0.07 }),
  fin({ p: [0.08, -0.70], len: 0.26, hw: 0.03, sweep: 0.20, h: 0.42, mirror: true }),
  nacelle({ p: [0, -0.72], len: 0.26, r: 0.085 }),
  lamp([0, 1.10], 0.036, 2.8),
  lamp([0.60, -0.42], 0.028, 1.5),
  lamp([-0.60, -0.42], 0.028, 1.5),
];

// --- medium ---------------------------------------------------------------------

const splitter = [
  // Reads as two half-craft clamped together, which is what it becomes.
  loft([[0.90, 0.07, 0.13], [0.44, 0.16, 0.25], [-0.10, 0.19, 0.27],
        [-0.66, 0.12, 0.17]]),
  plate({ p: [0, 0.10], hw: 0.44, hh: 0.16, h: 0.20, m: 0.9 }),
  canopy({ p: [0.22, 0.30], rx: 0.085, ry: 0.15, h: 0.38, mirror: true }),
  wing({ y: -0.06, root: 0.44, tip: 0.18, span: 0.84, x0: 0.30, sweep: 0.24, h: 0.09 }),
  fin({ p: [0.34, -0.40], len: 0.24, hw: 0.035, sweep: 0.14, h: 0.40, mirror: true }),
  nacelle({ p: [0.30, -0.56], len: 0.30, r: 0.10, mirror: true }),
  pylon({ p: [0.60, 0.02], hw: 0.04, hh: 0.09 }),
  store({ p: [0.60, -0.02], len: 0.22 }),
  lamp([0.22, 0.44], 0.042, 2.0),
  lamp([-0.22, 0.44], 0.042, 2.0),
];

const sentinel = [
  loft([[1.06, 0.055, 0.11], [0.70, 0.15, 0.24], [0.18, 0.21, 0.32],
        [-0.34, 0.18, 0.27], [-0.84, 0.10, 0.16]]),
  canopy({ p: [0, 0.40], rx: 0.11, ry: 0.20, h: 0.44 }),
  dome({ p: [0, -0.10], r: 0.17, h: 0.42, m: 1.05 }),
  barrel({ p: [0, -0.10], len: 0.44, r: 0.04, h: 0.46 }),
  wing({ y: 0.04, root: 0.54, tip: 0.20, span: 0.92, x0: 0.18, sweep: 0.30, h: 0.10 }),
  ...tailplane(-0.74, 0.38, 0.18),
  fin({ p: [0.14, -0.66], len: 0.30, hw: 0.04, sweep: 0.16, h: 0.48, mirror: true }),
  nacelle({ p: [0.26, -0.52], len: 0.38, r: 0.10, mirror: true }),
  pylon({ p: [0.52, 0.0], hw: 0.045, hh: 0.10 }),
  store({ p: [0.52, -0.04], len: 0.26 }),
  lamp([0, 0.56], 0.05, 2.2),
  lamp([0.96, -0.24], 0.034, 1.6),
  lamp([-0.96, -0.24], 0.034, 1.6),
];

const brute = [
  loft([[0.94, 0.10, 0.16], [0.52, 0.24, 0.34], [0.0, 0.30, 0.40],
        [-0.50, 0.25, 0.33], [-0.90, 0.15, 0.20]], { m: 1.05 }),
  canopy({ p: [0, 0.44], rx: 0.13, ry: 0.18, h: 0.50 }),
  plate({ p: [0, 0.16], hw: 0.36, hh: 0.22, h: 0.30, m: 0.92 }),
  wing({ y: 0.0, root: 0.62, tip: 0.26, span: 1.00, x0: 0.26, sweep: 0.22, h: 0.13 }),
  dome({ p: [0.40, 0.18], r: 0.11, h: 0.44, mirror: true }),
  barrel({ p: [0.40, 0.30], len: 0.30, r: 0.035, h: 0.48, mirror: true }),
  ...tailplane(-0.82, 0.42, 0.20),
  fin({ p: [0.20, -0.70], len: 0.32, hw: 0.045, sweep: 0.16, h: 0.52, mirror: true }),
  nacelle({ p: [0.32, -0.58], len: 0.42, r: 0.13, mirror: true }),
  lamp([0, 0.62], 0.055, 2.2),
  lamp([1.02, -0.28], 0.038, 1.6),
  lamp([-1.02, -0.28], 0.038, 1.6),
];

const gunship = [
  loft([[0.92, 0.12, 0.18], [0.46, 0.28, 0.34], [-0.06, 0.32, 0.38],
        [-0.58, 0.26, 0.30], [-0.94, 0.16, 0.19]]),
  canopy({ p: [0, 0.48], rx: 0.15, ry: 0.17, h: 0.48 }),
  plate({ p: [0, -0.10], hw: 0.40, hh: 0.26, h: 0.28, m: 0.9 }),
  wing({ y: 0.02, root: 0.44, tip: 0.30, span: 1.04, x0: 0.30, sweep: 0.10, h: 0.12 }),
  dome({ p: [0, 0.10], r: 0.15, h: 0.46 }),
  barrel({ p: [0, 0.10], len: 0.40, r: 0.045, h: 0.50 }),
  barrel({ p: [0.52, 0.06], len: 0.26, r: 0.03, h: 0.30, mirror: true }),
  nacelle({ p: [0.62, -0.18], len: 0.40, r: 0.13, mirror: true }),
  fin({ p: [0.34, -0.70], len: 0.30, hw: 0.045, sweep: 0.10, h: 0.48, mirror: true }),
  pylon({ p: [0.82, -0.04], hw: 0.05, hh: 0.11 }),
  store({ p: [0.82, -0.10], len: 0.28, r: 0.06 }),
  lamp([0, 0.64], 0.05, 2.0),
  lamp([1.06, -0.20], 0.036, 1.6),
  lamp([-1.06, -0.20], 0.036, 1.6),
];

const bomber = [
  // Deep belly, straight wing, four nozzles, visible bombs.
  loft([[0.86, 0.14, 0.22], [0.38, 0.30, 0.42], [-0.14, 0.34, 0.46],
        [-0.62, 0.28, 0.36], [-0.96, 0.17, 0.22]], { m: 1.05 }),
  canopy({ p: [0, 0.46], rx: 0.16, ry: 0.16, h: 0.54 }),
  wing({ y: -0.04, root: 0.52, tip: 0.32, span: 1.12, x0: 0.32, sweep: 0.06, h: 0.13 }),
  nacelle({ p: [0.50, -0.20], len: 0.40, r: 0.115, mirror: true }),
  nacelle({ p: [0.82, -0.14], len: 0.34, r: 0.095, mirror: true }),
  pylon({ p: [0.34, -0.06], hw: 0.055, hh: 0.13 }),
  store({ p: [0.34, -0.14], len: 0.34, r: 0.075 }),
  ...tailplane(-0.86, 0.46, 0.22),
  fin({ p: [0, -0.78], len: 0.36, hw: 0.05, sweep: 0.12, h: 0.56 }),
  lamp([0, 0.62], 0.055, 2.4),
  lamp([1.14, -0.26], 0.04, 1.8),
  lamp([-1.14, -0.26], 0.04, 1.8),
];

const radial = [
  // Rotationally symmetric weapons platform: a hub with eight barrels.
  dome({ p: [0, 0], r: 0.40, h: 0.52, m: 1.05 }),
  loft([[0.66, 0.10, 0.16], [0.20, 0.20, 0.26], [-0.30, 0.18, 0.22],
        [-0.66, 0.10, 0.14]], { m: 0.9 }),
  ...[0, 1, 2, 3].flatMap((i) => {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const c = Math.cos(a), s = Math.sin(a);
    return [
      barrel({ p: [c * 0.52, s * 0.52], len: 0.44, r: 0.05, ang: a, h: 0.34, mirror: true }),
      plate({ p: [c * 0.34, s * 0.34], hw: 0.09, hh: 0.09, rot: a, h: 0.30, m: 0.9, mirror: true }),
    ];
  }),
  canopy({ p: [0, 0.14], rx: 0.13, ry: 0.13, h: 0.60 }),
  lamp([0, 0.44], 0.05, 2.2),
];

const shielder = [
  dome({ p: [0, 0], r: 0.46, h: 0.56, m: 1.0 }),
  loft([[0.72, 0.09, 0.14], [0.22, 0.20, 0.26], [-0.32, 0.17, 0.22],
        [-0.70, 0.09, 0.13]], { m: 0.9 }),
  canopy({ p: [0, 0.10], rx: 0.20, ry: 0.20, h: 0.66 }),
  // Three emitter pylons standing proud of the disc.
  ...[0, 1, 2].map((i) => {
    const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
    return fin({ p: [Math.cos(a) * 0.42, Math.sin(a) * 0.42], len: 0.20, hw: 0.055,
      sweep: 0, h: 0.60, m: 1.1 });
  }),
  ...[0, 1, 2].map((i) => {
    const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
    return lamp([Math.cos(a) * 0.42, Math.sin(a) * 0.42 + 0.12], 0.05, 2.6);
  }),
  nacelle({ p: [0.22, -0.54], len: 0.24, r: 0.075, mirror: true }),
];

const warden = [
  dome({ p: [0, 0], r: 0.34, h: 0.50 }),
  loft([[0.74, 0.08, 0.13], [0.26, 0.19, 0.25], [-0.28, 0.17, 0.21],
        [-0.68, 0.09, 0.13]], { m: 0.9 }),
  canopy({ p: [0, 0.12], rx: 0.15, ry: 0.15, h: 0.58 }),
  fin({ p: [0.30, -0.20], len: 0.26, hw: 0.05, sweep: 0.08, h: 0.52, mirror: true }),
  nacelle({ p: [0.20, -0.56], len: 0.26, r: 0.08, mirror: true }),
  lamp([0, 0.34], 0.05, 2.4),
  orbit({ n: 3, r: 0.86, size: 0.09, speed: 1.1, m: 1 }),
];

const dread = [
  loft([[1.00, 0.13, 0.20], [0.50, 0.30, 0.40], [-0.04, 0.36, 0.46],
        [-0.58, 0.30, 0.38], [-1.00, 0.18, 0.24]], { m: 1.05 }),
  canopy({ p: [0, 0.52], rx: 0.15, ry: 0.18, h: 0.54 }),
  plate({ p: [0, 0.06], hw: 0.46, hh: 0.28, h: 0.34, m: 0.95 }),
  wing({ y: -0.02, root: 0.60, tip: 0.28, span: 1.06, x0: 0.34, sweep: 0.16, h: 0.14 }),
  dome({ p: [0.34, 0.26], r: 0.13, h: 0.52, mirror: true }),
  barrel({ p: [0.34, 0.40], len: 0.32, r: 0.04, h: 0.56, mirror: true }),
  dome({ p: [0, -0.34], r: 0.16, h: 0.50 }),
  barrel({ p: [0, -0.34], len: 0.34, r: 0.045, h: 0.54 }),
  nacelle({ p: [0.36, -0.66], len: 0.40, r: 0.125, mirror: true }),
  fin({ p: [0.18, -0.80], len: 0.34, hw: 0.05, sweep: 0.14, h: 0.56, mirror: true }),
  lamp([0, 0.70], 0.055, 2.2),
  lamp([1.08, -0.30], 0.04, 1.6),
  lamp([-1.08, -0.30], 0.04, 1.6),
];

const juggernaut = [
  loft([[0.94, 0.18, 0.26], [0.42, 0.38, 0.46], [-0.10, 0.44, 0.52],
        [-0.62, 0.36, 0.42], [-1.00, 0.22, 0.26]], { m: 1.05 }),
  plate({ p: [0, 0.20], hw: 0.52, hh: 0.30, h: 0.40, m: 0.95 }),
  plate({ p: [0, -0.30], hw: 0.44, hh: 0.24, h: 0.36, m: 0.9 }),
  canopy({ p: [0, 0.54], rx: 0.17, ry: 0.15, h: 0.62 }),
  wing({ y: -0.06, root: 0.56, tip: 0.34, span: 1.06, x0: 0.42, sweep: 0.10, h: 0.16 }),
  dome({ p: [0.44, 0.16], r: 0.15, h: 0.60, mirror: true }),
  barrel({ p: [0.44, 0.32], len: 0.34, r: 0.045, h: 0.64, mirror: true }),
  dome({ p: [0, -0.02], r: 0.19, h: 0.66 }),
  barrel({ p: [0, -0.02], len: 0.46, r: 0.055, h: 0.70 }),
  nacelle({ p: [0.28, -0.74], len: 0.36, r: 0.115, mirror: true }),
  nacelle({ p: [0.66, -0.62], len: 0.30, r: 0.095, mirror: true }),
  fin({ p: [0.22, -0.82], len: 0.32, hw: 0.055, sweep: 0.10, h: 0.60, mirror: true }),
  lamp([0, 0.74], 0.06, 2.2),
  lamp([1.08, -0.32], 0.042, 1.6),
  lamp([-1.08, -0.32], 0.042, 1.6),
];

const boss = [
  loft([[1.04, 0.16, 0.24], [0.52, 0.40, 0.48], [0.0, 0.48, 0.56],
        [-0.54, 0.40, 0.46], [-1.04, 0.24, 0.28]], { m: 1.05 }),
  plate({ p: [0, 0.26], hw: 0.56, hh: 0.28, h: 0.44, m: 0.95 }),
  plate({ p: [0, -0.34], hw: 0.50, hh: 0.26, h: 0.40, m: 0.9 }),
  canopy({ p: [0, 0.56], rx: 0.19, ry: 0.16, h: 0.66 }),
  wing({ y: -0.04, root: 0.64, tip: 0.30, span: 1.14, x0: 0.46, sweep: 0.18, h: 0.16 }),
  dome({ p: [0.52, 0.20], r: 0.16, h: 0.62, mirror: true }),
  barrel({ p: [0.52, 0.38], len: 0.38, r: 0.05, h: 0.66, mirror: true }),
  dome({ p: [0, 0.04], r: 0.22, h: 0.72 }),
  barrel({ p: [0, 0.04], len: 0.56, r: 0.065, h: 0.76 }),
  pylon({ p: [0.78, -0.14], hw: 0.06, hh: 0.14 }),
  store({ p: [0.78, -0.22], len: 0.34, r: 0.07 }),
  nacelle({ p: [0.30, -0.80], len: 0.38, r: 0.125, mirror: true }),
  nacelle({ p: [0.70, -0.68], len: 0.32, r: 0.10, mirror: true }),
  fin({ p: [0.24, -0.86], len: 0.36, hw: 0.06, sweep: 0.12, h: 0.64, mirror: true }),
  lamp([0, 0.78], 0.065, 2.6),
  lamp([1.16, -0.34], 0.045, 1.8),
  lamp([-1.16, -0.34], 0.045, 1.8),
];

// --- ground emplacements --------------------------------------------------------

const turret = [
  plate({ p: [0, 0], hw: 0.52, hh: 0.52, h: 0.14, m: 0.8 }),
  dome({ p: [0, 0], r: 0.40, h: 0.30, m: 0.85 }),
  dome({ p: [0, 0.02], r: 0.26, h: 0.50, m: 1.0 }),
  barrel({ p: [0.09, 0.20], len: 0.62, r: 0.05, h: 0.54, mirror: true }),
  plate({ p: [0, -0.30], hw: 0.20, hh: 0.12, h: 0.42, m: 0.9 }),
  lamp([0, -0.34], 0.05, 2.0),
];

const sam = [
  plate({ p: [0, 0], hw: 0.50, hh: 0.44, h: 0.14, m: 0.8 }),
  dome({ p: [0, -0.06], r: 0.28, h: 0.34, m: 0.9 }),
  // A canted launch rack, which is what makes it read as SAM and not turret.
  plate({ p: [0, 0.18], hw: 0.30, hh: 0.22, rot: 0, h: 0.44, m: 0.95 }),
  store({ p: [0.11, 0.30], len: 0.40, r: 0.065, h: 0.56 }),
  store({ p: [0.26, 0.24], len: 0.34, r: 0.055, h: 0.52 }),
  dome({ p: [0, -0.36], r: 0.13, h: 0.40 }),
  lamp([0, -0.38], 0.045, 2.2),
];

const tank = [
  plate({ p: [0, 0], hw: 0.42, hh: 0.62, h: 0.24, m: 0.9 }),
  plate({ p: [0.46, 0], hw: 0.12, hh: 0.64, h: 0.20, m: 0.75, mirror: true }),
  dome({ p: [0, 0.02], r: 0.28, h: 0.46, m: 1.0 }),
  barrel({ p: [0, 0.22], len: 0.66, r: 0.05, h: 0.50 }),
  plate({ p: [0, -0.44], hw: 0.22, hh: 0.14, h: 0.34, m: 0.85 }),
  lamp([0.20, 0.44], 0.045, 1.8),
  lamp([-0.20, 0.44], 0.045, 1.8),
];

const warship = [
  loft([[1.10, 0.10, 0.16], [0.60, 0.26, 0.26], [0.0, 0.32, 0.30],
        [-0.66, 0.28, 0.26], [-1.10, 0.16, 0.18]], { m: 0.95 }),
  plate({ p: [0, 0.10], hw: 0.24, hh: 0.40, h: 0.44, m: 1.0 }),
  plate({ p: [0, 0.42], hw: 0.16, hh: 0.18, h: 0.56, m: 1.05 }),
  fin({ p: [0, 0.50], len: 0.30, hw: 0.04, sweep: 0, h: 0.72 }),
  dome({ p: [0, 0.70], r: 0.15, h: 0.44 }),
  barrel({ p: [0, 0.84], len: 0.34, r: 0.045, h: 0.48 }),
  dome({ p: [0, -0.46], r: 0.15, h: 0.44 }),
  barrel({ p: [0, -0.32], len: 0.30, r: 0.045, h: 0.48 }),
  plate({ p: [0.30, -0.10], hw: 0.09, hh: 0.20, h: 0.36, m: 0.9, mirror: true }),
  lamp([0, 0.96], 0.045, 2.0),
  lamp([0.34, 0.10], 0.035, 1.6),
  lamp([-0.34, 0.10], 0.035, 1.6),
];

export const AIRFRAMES = {
  ship: interceptor,
  drone, darter, brute, splitter, shielder, sentinel, gunship, radial,
  lancer, dread, wraith, boss, mite, bomber, juggernaut, sniper, warden,
  turret, tank, warship, sam,
};

/** Flattened, mirrors resolved. Every consumer reads this. */

// --- ground structures ----------------------------------------------------------
//
// The terrain was tinted polygons: an island was a green heptagon, a base was a
// grey one with a stripe. Next to baked airframes that reads as a placeholder.
// These are built from the same vocabulary and baked into the same atlas, so a
// hangar on an island is lit and occluded exactly like a craft is.

const hangar = [
  plate({ p: [0, 0], hw: 0.62, hh: 0.44, h: 0.30, m: 0.92 }),
  loft([[0.40, 0.60, 0.52], [0.10, 0.62, 0.56], [-0.20, 0.62, 0.56],
        [-0.44, 0.58, 0.48]], { m: 1.0 }),               // barrel roof
  plate({ p: [0, 0.46], hw: 0.56, hh: 0.06, h: 0.34, m: 0.8 }),  // door header
  plate({ p: [0.30, 0.48], hw: 0.22, hh: 0.05, h: 0.20, m: 0.7, mirror: true }),
  barrel({ p: [0.44, -0.48], len: 0.22, r: 0.03, ang: 0, h: 0.40, mirror: true }),
  lamp([0.50, 0.42], 0.04, 2.0),
  lamp([-0.50, 0.42], 0.04, 2.0),
];

const controlTower = [
  plate({ p: [0, -0.30], hw: 0.34, hh: 0.30, h: 0.24, m: 0.85 }),
  plate({ p: [0, -0.05], hw: 0.16, hh: 0.34, h: 0.52, m: 0.95 }),
  plate({ p: [0, 0.34], hw: 0.30, hh: 0.20, h: 0.74, m: 1.05 }),   // glazed cab
  canopy({ p: [0, 0.34], rx: 0.26, ry: 0.16, h: 0.80 }),
  fin({ p: [0, 0.56], len: 0.34, hw: 0.022, sweep: 0, h: 0.96 }),  // mast
  lamp([0, 0.70], 0.045, 2.8),
  lamp([0.30, -0.36], 0.035, 1.6),
  lamp([-0.30, -0.36], 0.035, 1.6),
];

const radar = [
  plate({ p: [0, -0.44], hw: 0.30, hh: 0.20, h: 0.22, m: 0.85 }),
  plate({ p: [0, -0.16], hw: 0.10, hh: 0.30, h: 0.44, m: 0.9 }),
  dome({ p: [0, 0.22], r: 0.44, h: 0.62, m: 1.05 }),
  plate({ p: [0, 0.22], hw: 0.40, hh: 0.05, h: 0.70, m: 0.75 }),
  barrel({ p: [0, 0.22], len: 0.30, r: 0.025, h: 0.76 }),
  lamp([0, 0.54], 0.04, 2.6),
];

const silo = [
  plate({ p: [0, 0], hw: 0.60, hh: 0.50, h: 0.16, m: 0.8 }),
  dome({ p: [-0.28, 0.16], r: 0.26, h: 0.62, m: 1.0 }),
  dome({ p: [0.26, 0.14], r: 0.22, h: 0.56, m: 1.0 }),
  dome({ p: [-0.02, -0.28], r: 0.20, h: 0.52, m: 0.95 }),
  barrel({ p: [-0.28, 0.16], len: 0.30, r: 0.028, h: 0.68 }),
  barrel({ p: [0.26, 0.14], len: 0.26, r: 0.026, h: 0.62 }),
  lamp([-0.28, 0.30], 0.035, 2.2),
  lamp([0.26, 0.26], 0.032, 2.0),
];

const crane = [
  plate({ p: [0, -0.44], hw: 0.28, hh: 0.18, h: 0.20, m: 0.85 }),
  plate({ p: [0, -0.20], hw: 0.14, hh: 0.26, h: 0.52, m: 0.95 }),
  plate({ p: [0, 0.24], hw: 0.10, hh: 0.62, h: 0.72, m: 1.0 }),    // jib
  plate({ p: [0, 0.78], hw: 0.20, hh: 0.08, h: 0.66, m: 0.9 }),
  plate({ p: [0, -0.44], hw: 0.34, hh: 0.10, h: 0.26, m: 0.8 }),
  barrel({ p: [0, 0.70], len: 0.30, r: 0.02, ang: Math.PI, h: 0.40 }),
  lamp([0, 0.84], 0.035, 2.4),
];

const containers = [
  plate({ p: [-0.34, 0.26], hw: 0.26, hh: 0.14, h: 0.34, m: 1.0 }),
  plate({ p: [0.22, 0.30], hw: 0.28, hh: 0.13, h: 0.30, m: 0.92 }),
  plate({ p: [-0.10, -0.04], hw: 0.30, hh: 0.14, h: 0.44, m: 1.05 }),
  plate({ p: [0.36, -0.10], hw: 0.22, hh: 0.13, h: 0.32, m: 0.88 }),
  plate({ p: [-0.30, -0.36], hw: 0.26, hh: 0.14, h: 0.30, m: 0.95 }),
  plate({ p: [0.18, -0.40], hw: 0.24, hh: 0.12, h: 0.26, m: 1.0 }),
];

const bunker = [
  plate({ p: [0, 0], hw: 0.50, hh: 0.38, h: 0.34, m: 0.95 }),
  dome({ p: [0, 0.04], r: 0.30, h: 0.46, m: 1.0 }),
  plate({ p: [0, 0.30], hw: 0.34, hh: 0.06, h: 0.40, m: 0.8 }),
  barrel({ p: [0, 0.28], len: 0.26, r: 0.035, h: 0.44 }),
  lamp([0.36, -0.24], 0.035, 1.8),
  lamp([-0.36, -0.24], 0.035, 1.8),
];

const grove = [
  dome({ p: [-0.30, 0.24], r: 0.28, h: 0.62, m: 1.0 }),
  dome({ p: [0.24, 0.30], r: 0.22, h: 0.52, m: 0.92 }),
  dome({ p: [0.34, -0.16], r: 0.30, h: 0.66, m: 1.05 }),
  dome({ p: [-0.20, -0.30], r: 0.26, h: 0.56, m: 0.95 }),
  dome({ p: [0.02, 0.00], r: 0.24, h: 0.60, m: 1.0 }),
  dome({ p: [-0.44, -0.06], r: 0.18, h: 0.44, m: 0.88 }),
];

const outcrop = [
  dome({ p: [0.06, 0.10], r: 0.46, h: 0.70, m: 1.0 }),
  dome({ p: [-0.34, -0.12], r: 0.30, h: 0.52, m: 0.9 }),
  dome({ p: [0.34, -0.30], r: 0.26, h: 0.44, m: 0.95 }),
  dome({ p: [-0.12, 0.44], r: 0.22, h: 0.38, m: 0.86 }),
];

const pier = [
  plate({ p: [0, 0.10], hw: 0.14, hh: 0.72, h: 0.20, m: 0.9 }),
  plate({ p: [0, -0.58], hw: 0.42, hh: 0.16, h: 0.22, m: 0.95 }),
  // Piles under the deck, which is what makes it read as a jetty and not a bar.
  ...[0.5, 0.15, -0.2, -0.5].flatMap((y) => [
    barrel({ p: [0.11, y], len: 0.10, r: 0.030, h: 0.12, m: 0.8, mirror: true }),
  ]),
  plate({ p: [0.26, 0.34], hw: 0.10, hh: 0.10, h: 0.34, m: 1.0 }),
  lamp([0, 0.78], 0.035, 2.2),
  lamp([0.26, 0.42], 0.03, 1.8),
];

const depot = [
  plate({ p: [0, 0], hw: 0.62, hh: 0.46, h: 0.14, m: 0.85 }),
  plate({ p: [-0.26, 0.18], hw: 0.26, hh: 0.20, h: 0.40, m: 1.0 }),
  plate({ p: [0.28, 0.20], hw: 0.22, hh: 0.16, h: 0.34, m: 0.95 }),
  dome({ p: [-0.02, -0.24], r: 0.20, h: 0.46, m: 1.0 }),
  barrel({ p: [-0.26, 0.36], len: 0.20, r: 0.024, h: 0.48 }),
  plate({ p: [0.34, -0.26], hw: 0.18, hh: 0.10, h: 0.26, m: 0.9 }),
  lamp([-0.26, 0.32], 0.032, 2.2),
  lamp([0.28, 0.30], 0.03, 2.0),
];

const mast = [
  plate({ p: [0, -0.62], hw: 0.24, hh: 0.14, h: 0.18, m: 0.85 }),
  plate({ p: [0, -0.06], hw: 0.085, hh: 0.60, h: 0.72, m: 1.0 }),
  plate({ p: [0, 0.10], hw: 0.34, hh: 0.055, h: 0.62, m: 0.9 }),
  plate({ p: [0, 0.36], hw: 0.26, hh: 0.050, h: 0.68, m: 0.9 }),
  dome({ p: [0, 0.58], r: 0.09, h: 0.78, m: 1.05 }),
  lamp([0, 0.62], 0.045, 3.0),
  lamp([0.30, 0.10], 0.028, 1.8),
  lamp([-0.30, 0.10], 0.028, 1.8),
];

export const STRUCTURES = {
  hangar, tower: controlTower, radar, silo, crane, containers, bunker,
  grove, outcrop, pier, depot, mast,
};

/** Structures share the airframe pipeline: same expansion, same bake, same atlas. */
export const STRUCTURE_PARTS = Object.fromEntries(
  Object.entries(STRUCTURES).map(([k, v]) => [k, expand(v)]));

// --- bosses ---------------------------------------------------------------------
//
// Every boss used the same silhouette and the same sine-wave pace, differing
// only in what came out of it. Six encounters that looked identical. These are
// built to read as different MACHINES at a glance — a gun fortress, a walker, a
// carrier, a rail platform, a hive barge and something that is not built at all.

const bossHarbour = [
  // Squat armoured emplacement: a wide base ring and one enormous turret.
  plate({ p: [0, 0], hw: 0.86, hh: 0.62, h: 0.28, m: 0.9 }),
  plate({ p: [0.62, 0.34], hw: 0.24, hh: 0.20, h: 0.40, m: 0.95, mirror: true }),
  dome({ p: [0, 0.02], r: 0.52, h: 0.62, m: 1.05 }),
  dome({ p: [0, 0.06], r: 0.30, h: 0.78, m: 1.1 }),
  barrel({ p: [0.10, 0.30], len: 0.86, r: 0.075, h: 0.80, mirror: true }),
  dome({ p: [0.66, -0.34], r: 0.16, h: 0.46, mirror: true }),
  barrel({ p: [0.66, -0.20], len: 0.34, r: 0.045, h: 0.50, mirror: true }),
  lamp([0, 0.44], 0.07, 2.6),
  lamp([0.86, 0.50], 0.05, 2.0),
  lamp([-0.86, 0.50], 0.05, 2.0),
];

const bossWalker = [
  // Legged siege platform. The legs are the read — nothing else in the game
  // has limbs.
  plate({ p: [0, 0.10], hw: 0.50, hh: 0.42, h: 0.52, m: 1.0 }),
  canopy({ p: [0, 0.34], rx: 0.24, ry: 0.16, h: 0.66 }),
  ...[0.62, 0.10, -0.42].flatMap((y, i) => [
    plate({ p: [0.62, y], hw: 0.10, hh: 0.30, rot: 0.28 - i * 0.2, h: 0.30, m: 0.9, mirror: true }),
    plate({ p: [0.92, y - 0.16], hw: 0.08, hh: 0.26, rot: -0.34, h: 0.20, m: 0.82, mirror: true }),
  ]),
  dome({ p: [0.30, 0.34], r: 0.15, h: 0.60, mirror: true }),
  barrel({ p: [0.30, 0.48], len: 0.40, r: 0.05, h: 0.64, mirror: true }),
  plate({ p: [0, -0.44], hw: 0.34, hh: 0.20, h: 0.42, m: 0.92 }),
  lamp([0, 0.50], 0.065, 2.4),
  lamp([0.94, -0.60], 0.045, 1.8),
  lamp([-0.94, -0.60], 0.045, 1.8),
];

const bossCarrier = [
  // A flight deck. Long, flat, with an offset island and open launch bays.
  loft([[1.05, 0.26, 0.30], [0.50, 0.44, 0.38], [-0.20, 0.46, 0.38],
        [-0.92, 0.30, 0.28]], { m: 0.95 }),
  plate({ p: [0, 0.10], hw: 0.40, hh: 0.86, h: 0.30, m: 0.88 }),   // deck
  plate({ p: [0.46, 0.20], hw: 0.16, hh: 0.30, h: 0.66, m: 1.05 }), // island
  fin({ p: [0.46, 0.44], len: 0.34, hw: 0.035, sweep: 0, h: 0.86 }),
  dome({ p: [0.46, 0.30], r: 0.11, h: 0.72 }),
  // Launch bays, cut into the deck.
  plate({ p: [-0.16, 0.44], hw: 0.13, hh: 0.16, h: 0.18, m: 0.7 }),
  plate({ p: [-0.16, 0.02], hw: 0.13, hh: 0.16, h: 0.18, m: 0.7 }),
  plate({ p: [-0.16, -0.40], hw: 0.13, hh: 0.16, h: 0.18, m: 0.7 }),
  nacelle({ p: [0.24, -0.86], len: 0.34, r: 0.11, mirror: true }),
  lamp([-0.16, 0.44], 0.05, 2.6),
  lamp([-0.16, 0.02], 0.05, 2.6),
  lamp([-0.16, -0.40], 0.05, 2.6),
  lamp([0.46, 0.62], 0.045, 2.2),
];

const bossFortress = [
  // Armoured wedge built around two rail barrels that run its whole length.
  loft([[1.00, 0.20, 0.28], [0.40, 0.56, 0.50], [-0.30, 0.60, 0.52],
        [-0.98, 0.34, 0.30]], { m: 1.05 }),
  plate({ p: [0, 0.10], hw: 0.52, hh: 0.44, h: 0.56, m: 1.0 }),
  barrel({ p: [0.26, 0.20], len: 1.05, r: 0.085, h: 0.72, mirror: true }),
  plate({ p: [0.26, -0.10], hw: 0.13, hh: 0.26, h: 0.62, m: 0.95, mirror: true }),
  canopy({ p: [0, -0.16], rx: 0.20, ry: 0.16, h: 0.70 }),
  fin({ p: [0.44, -0.52], len: 0.34, hw: 0.055, sweep: 0.10, h: 0.62, mirror: true }),
  nacelle({ p: [0.20, -0.82], len: 0.34, r: 0.115, mirror: true }),
  lamp([0.26, 0.86], 0.05, 3.0),
  lamp([-0.26, 0.86], 0.05, 3.0),
  lamp([0, -0.30], 0.055, 2.2),
];

const bossHive = [
  // Organic barge: a bulbous hull studded with brood pods. No hard edges.
  loft([[0.92, 0.30, 0.40], [0.30, 0.60, 0.62], [-0.34, 0.58, 0.58],
        [-0.94, 0.32, 0.34]], { m: 1.0 }),
  dome({ p: [0, 0.16], r: 0.40, h: 0.74, m: 1.05 }),
  ...[[0.44, 0.40], [0.52, -0.06], [0.40, -0.50], [0.20, 0.62]].map(([px, py]) =>
    dome({ p: [px, py], r: 0.17, h: 0.56, m: 0.95, mirror: true })),
  dome({ p: [0, -0.52], r: 0.22, h: 0.58, m: 0.95 }),
  nacelle({ p: [0.30, -0.84], len: 0.28, r: 0.10, mirror: true }),
  lamp([0, 0.34], 0.075, 2.8),
  lamp([0.52, 0.40], 0.045, 2.2),
  lamp([-0.52, 0.40], 0.045, 2.2),
  lamp([0.60, -0.06], 0.045, 2.2),
  lamp([-0.60, -0.06], 0.045, 2.2),
];

const bossMonolith = [
  // Not built: a floating prism with orbiting shards. Deliberately the only
  // boss with no nacelles, no canopy and no guns you can point at.
  plate({ p: [0, 0], hw: 0.34, hh: 0.90, h: 0.86, m: 1.05 }),
  plate({ p: [0, 0.36], hw: 0.52, hh: 0.24, rot: 0.4, h: 0.70, m: 1.0 }),
  plate({ p: [0, -0.36], hw: 0.52, hh: 0.24, rot: -0.4, h: 0.70, m: 1.0 }),
  dome({ p: [0, 0], r: 0.26, h: 0.98, m: 1.1 }),
  plate({ p: [0.66, 0.10], hw: 0.12, hh: 0.30, rot: 0.5, h: 0.46, m: 0.9, mirror: true }),
  lamp([0, 0], 0.10, 3.2),
  lamp([0.72, 0.16], 0.05, 2.4),
  lamp([-0.72, 0.16], 0.05, 2.4),
  orbit({ n: 4, r: 1.05, size: 0.08, speed: 0.8, m: 1 }),
];

export const BOSS_FRAMES = {
  bossHarbour, bossWalker, bossCarrier, bossFortress, bossHive, bossMonolith,
};

export const AIRFRAME_PARTS = Object.fromEntries(
  Object.entries({ ...AIRFRAMES, ...BOSS_FRAMES }).map(([k, v]) => [k, expand(v)]));
