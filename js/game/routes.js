// Flight routes.
//
// Enemies used to home: 'swarm' rammed the ship, 'weave' tracked ship.x, 'dive'
// leaned toward it. Everything on screen was pointed at the player, which makes
// the lane feel like a funnel and removes any sense that these craft were going
// somewhere before you arrived.
//
// Sky Force Reloaded works the opposite way. Its enemies fly *committed routes* —
// they enter, sweep, arc, loop or strafe along a path decided at spawn, fire
// along the way, and leave. Formations fly the same route staggered. The threat
// comes from where the routes cross your lane, not from pursuit, and that is
// what makes the space feel like airspace rather than a corridor.
//
// A route is a list of waypoints in a normalised frame:
//   x in [0,1] across the playfield, y in playfield heights from the top.
// Enemies steer toward the current waypoint at their own speed rather than
// snapping to it, so a heavy craft arcs wide and a light one turns tight — the
// route is the intent, the airframe decides how well it is flown.

/**
 * @param {number} lane 0..1 — where this formation crosses.
 * @param {number} dir -1 or 1 — which way it sweeps.
 */
const ROUTES = {
  /** Straight down the lane. The baseline, and still the most common. */
  transit: (lane) => [[lane, 0.30], [lane, 0.72], [lane, 1.25]],

  /** Enters high, sweeps across the middle, exits the far side. */
  sweep: (lane, dir) => [
    [lane, 0.20], [lane + dir * 0.45, 0.48], [lane + dir * 0.80, 0.74], [lane + dir * 1.15, 1.00],
  ],

  /** A long S through the playfield — reads as a patrol, not an attack. */
  serpent: (lane, dir) => [
    [lane, 0.18], [lane + dir * 0.30, 0.40], [lane - dir * 0.25, 0.62],
    [lane + dir * 0.28, 0.84], [lane, 1.20],
  ],

  /** Dives to the lower third, turns and climbs back out. A strafing run. */
  strafe: (lane, dir) => [
    [lane, 0.26], [lane + dir * 0.18, 0.70], [lane + dir * 0.55, 0.88],
    [lane + dir * 0.85, 0.46], [lane + dir * 1.10, -0.15],
  ],

  /** Comes down one side, crosses the bottom, exits the other. */
  hook: (lane, dir) => [
    [lane, 0.34], [lane, 0.74], [lane + dir * 0.55, 0.92], [lane + dir * 1.15, 0.86],
  ],

  /** Holds a mid-field orbit for a while before leaving — artillery behaviour. */
  orbit: (lane, dir) => [
    [lane, 0.32], [lane + dir * 0.22, 0.50], [lane, 0.66],
    [lane - dir * 0.22, 0.50], [lane, 0.32], [lane, -0.2],
  ],

  /** Enters low from the side and climbs out — fills the bottom of the lane. */
  lowPass: (lane, dir) => [
    [lane, 0.42], [lane + dir * 0.30, 0.82], [lane + dir * 0.70, 0.95],
    [lane + dir * 1.15, 0.60],
  ],
};

export const ROUTE_NAMES = Object.keys(ROUTES);

/** Build a concrete waypoint list. */
export function makeRoute(name, lane, dir) {
  const fn = ROUTES[name] || ROUTES.transit;
  return fn(lane, dir);
}

/**
 * Which routes suit which behaviour class.
 *
 * Deliberately not uniform. Rammers still ram — removing every pursuer would
 * take all the pressure out of the lane — but they are now a minority rather
 * than the default, and everything else is going somewhere of its own.
 */
export const ROUTE_POOL = {
  swarm:  ['transit', 'strafe', 'hook', 'lowPass'],
  weave:  ['serpent', 'sweep', 'transit', 'lowPass'],
  dive:   ['transit', 'strafe', 'sweep', 'hook'],
  hover:  ['orbit', 'transit'],
};

/** Pick a route for a behaviour, given a random source. */
export function routeFor(behavior, rand) {
  const pool = ROUTE_POOL[behavior] || ROUTE_POOL.dive;
  return pool[Math.floor(rand() * pool.length) % pool.length];
}
