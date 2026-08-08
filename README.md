# ⬡ VOID BASTION

An infinite sci-fi idle shoot-'em-up for the browser. One ship flying forward
forever, an endless machine swarm, and an upgrade tree that never stops paying
out.

The guns fire themselves, the autopilot dodges, hull and shields regenerate.
Your job is deciding what to buy — but drag anywhere on the starfield and you
take the stick, with the autopilot easing back in when you let go.

**Play:** https://yudongqagent.github.io/void-bastion/

No build step, no dependencies, no accounts, no tracking. Vanilla ES modules and
a hand-written WebGL2 renderer, served as static files.

---

## The loop

The ship holds station near the bottom of the screen while the world streams
down past it. The swarm enters from the top and mostly kills itself against your
guns trying to ram you; kills scatter coins you have to fly over to collect.

| | |
|---|---|
| ⬤ **Coins** | Drop from kills and wave clears. Spent during a run in **UPGRADES**. Lost when the run ends. |
| ◆ **Cores** | Earned by ascending. Spent in the **LAB** on permanent research that survives forever. |

Runs are *designed* to end. Enemy health grows exponentially with the wave
number while your in-run upgrades grow linearly, so every run eventually hits a
wall. That is the pacing mechanism, not a failure state — you ascend, convert
the depth you reached into Cores, and the next run starts stronger than the last
one ever was.

Every 10th wave is a boss, and each boss opens a new **zone** — a fresh palette,
backdrop, scroll speed, hazard mix and one rule twist, cycling forever so wave
300 never looks like wave 30. Every 25th wave pays a milestone bonus. Abilities
unlock in the Lab and fire from the bottom bar or the <kbd>1</kbd>–<kbd>5</kbd>
keys. Progress saves to `localStorage` automatically.

### The autopilot

The steering behaviour is the heart of "fun to watch". Four weighted urges are
summed each frame and clamped: break away from anything about to hit, sidestep
incoming fire, drift toward loose loot, and hold station in the lower band.

It is deliberately imperfect. A pilot that never takes a hit removes all tension
and makes hull, shields and armour pointless to buy, so the threat radius is
short and the acceleration finite — it dodges what it can and wears what it
cannot. Thruster Vanes raises both, so evasion is a real upgrade axis.

Dragging on the play area overrides it. The override is a *blend*, not a switch:
it ramps to full over ~0.1s and eases back out over ~0.5s after release, so
control never snaps out from under a drag. Bounds forces apply either way — the
lane is the lane. Handlers live on the scene canvas rather than the window, so
the permanent upgrade panel painted over it keeps its own taps.

### Weapon systems

Beyond the main cannon there are five auto-firing systems, each an in-run
upgrade in the **OFFENSE** tab, level 0 meaning "not owned yet", and each with
its own permanent research track in the Lab:

| | |
|---|---|
| **Pulse Laser** | continuous beam welded to whatever the guns are tracking |
| **Seeker Pod** | homing missiles, more of them per level, detonating on contact |
| **Flak Cannon** | airburst over the thickest part of the swarm |
| **Arc Coil** | lightning chaining outward from your target |
| **Escort Wingmen** | wingmen flying formation and firing real tracers |

Each system owns a colour, used both for its light on screen and for a pip on
its upgrade card — laser cyan, missiles orange, flak gold, arc violet, wingmen
green. "Which upgrade made that?" should be answerable by looking, not reading.
That matters because several systems were previously invisible in play: flak
detonated instantly at a distant point (it now lobs a shell you can watch, with
a ghost ring marking where it will burst), missiles launched too fast to see
(now slower off the rail with a heavy exhaust trail), and wingman tracers were
identical to the main gun's.

Every one of them folds its output into `deriveStats().dps`. That is not
cosmetic: the buying AI in both harnesses ranks upgrades by DPS-per-coin, so a
weapon invisible to that calculation would simply never get bought, and the
balance runs would quietly ignore a whole tab.

### A targeting-range bug that hid three features

Wingmen "did not work", and measuring showed why: **zero damage events in sixty
seconds of play**. They sat at `ship.y + 12` — *below* the ship, further from
the enemy — and applied invisible continuous damage gated by targeting range.
The nearest enemy was ~560px away against a 262px range.

The range was the real culprit, inherited from the tower build where enemies
converged from every side. In a lane ~600px long it meant the guns could barely
see past their own nose, which silently broke the laser (never acquired a
target) and the Arc Coil (first hop failed a ship-centric distance test) too.
Base range went 190 → 340, wingmen now fly slightly ahead and fire real
tracers, and the arc seeds on the tracked target instead of chaining outward
from the hull.

### Craft silhouettes

Enemies are assembled from the same five SDF primitives in a local frame where
**+y is the heading** and the unit is the craft's radius, so each silhouette is
a handful of readable coordinates that works at any size or angle with no
sprites. Hulls draw *dim* and cockpits bright: parts blend additively, so a
craft of eight full-brightness pieces sums to white at the fuselage and every
archetype ends up looking identical. Silhouettes differ in outline, not just
colour — at phone size on a bloom-heavy background, shape is what the eye
actually resolves.

Density is a separate knob from difficulty. `SWARM_DENSITY` multiplies the enemy
count and divides per-enemy hull, payout and ram damage by the same factor, so
wave totals — and therefore the entire prestige curve — are untouched.

---

## Design notes

### Scaling

Everything numeric lives in [`js/game/balance.js`](js/game/balance.js), which
holds no DOM or rendering code so it can be imported directly by the tuning
harness.

```
enemy HP     9 · w^1.75 · 1.036^w      polynomial early, exponential forever after
enemy count  5 + 2.4·√w + 0.14w        sqrt-led so the screen stays readable
enemy speed  min(78, 24 + 11·log₁₀w)   near-flat: fast stops being "hard" and starts being unreadable
contact      enemyDamage · 0.60         ramming chips rather than cripples — a moving ship gets bumped a lot
coin drop    2.2 · HP^0.55             deliberately sub-linear in HP
upgrade cost base · growth^level       ~1.13–1.34 depending on the stat
cores earned 0.42 · 1.016^w · w^0.9    exponential, mirroring enemy HP
```

The HP curve is polynomial-dominant until roughly wave 80 so the early game
ramps gently, then the exponential takes over and never stops.

### Why in-run upgrades are additive and Lab research compounds

This asymmetry is the whole economy.

In-run stats add a flat amount per level against an exponential cost, which
produces the classic idle-game decay: every level is worth buying, each is worth
slightly less. Player DPS is the *product* of several such stats (damage × fire
rate × crit × multishot), so it grows polynomially — fast, but never fast enough
to catch an exponential HP curve. Runs end. Good.

The Lab has to make up that difference, and it can only do so if meta-power
grows exponentially in the *number of prestiges*. So Lab bonuses multiply
(`1.09^level`) and the Core reward is itself exponential in wave reached. The
relationship that keeps gains from decaying is roughly

```
ln(CORE_BASE) ≈ ln(HP_BASE) · ln(labCostGrowth) / ln(labMultiplier)
```

An earlier version of this game used additive Lab bonuses and a polynomial Core
reward. It flatlined at **+0 waves per prestige by run 8** — the exact "flat
grind" this design is meant to avoid.

### Tuning

`CORE_BASE` is the single most sensitive constant, and it was picked by sweeping
rather than by guessing:

| CORE_BASE | behaviour |
|---|---|
| 1.011 | gains decay toward a plateau |
| **1.016** | **steady ~+19 waves per prestige** ← shipped |
| 1.019 | gains accelerate |
| 1.024+ | runaway; the player outruns the curve entirely |

Measured over 24 simulated prestiges: first run ends ~wave 57, run 24 ends
~wave 498, with no plateau and no runaway. Because the autopilot makes
survivability an emergent property of the steering code rather than something
`balance.js` can predict, actual run depth is measured, not assumed —
`tools/headless.mjs --natural` plays unaided runs to death and reports the
distribution. Current median for run 1 is **wave 60** across trials.

### Anti-stall

Sentinels hover and shoot instead of closing, so a ship with strong regen but
not enough damage could sit in one wave indefinitely — neither winning nor
dying. After 100 seconds in a single wave the survivors **enrage**: faster and
hitting harder, without limit. The standoff always resolves.

### Where difficulty actually comes from

Contact damage is a dead knob. Sweeping `CONTACT_SCALE` across a 3× range moved
median run depth by noise, because an autopilot that dodges makes ramming close
to free. Pressure has to come from things that **cannot** be side-stepped, which
is exactly the lesson of the reference game: Sky Force's threat is ordnance, not
collisions. So the swarm gained three layers:

* **Weight decay.** Archetypes fade toward a floor over `decay` waves as well as
  ramping in. Without it, basic Drones are still the most common enemy at wave
  300 and the swarm never changes character. Now the roster's centre of mass
  drifts to the heavy, armed end — 61% Drones at wave 10, 44% heavy gunners at
  wave 160.
* **Elites.** A rising share of the wave (0% before 22, capping at 40%) that is
  tougher, hits harder, pays triple, and *always carries a weapon* even if its
  archetype rams for a living. Marked with a gold chevron ring.
* **Real weapons.** Aimed shots, decelerating homing volleys, five-shot spreads,
  rotating radial sprays and telegraphed beam columns, plus bosses that
  alternate fan and spiral patterns.

`WEAPON_SCALE` is the single knob for how hard the swarm shoots. Weapon damage
is expressed relative to an enemy's *contact* damage, and at parity three elite
volleys ended a run — a projectile connects far more often than a ram does.

Measured on the real loop across a 10-prestige career: run 1 ends at wave 40 in
~20 minutes, run 10 at wave 80 in ~29 minutes, growth steady and positive. Before
this pass an unaided run 1 reached wave 75 and took 44 minutes, which was simply
too easy.

### A bug worth recording

Zone debris used to spawn at ~28 rocks a minute and dealt full unscaled
`enemyDamage` on collision. Unaided runs died on **wave 16**, always inside the
Asteroid Belt — the exact "hard-counter an idle player" case the zone design
rules out. Rocks are now shootable (they drop ore, which is what makes the Belt
worth its coin bonus), spawn far more slowly, and their collision damage is
scaled like any other contact. Median run depth went 16 → 60 from that one fix.
The lesson: sweeping `CONTACT_SCALE` first showed almost no effect, because
ramming was never the thing killing the ship.

---

## Rendering

A hand-written WebGL2 renderer ([`js/gl/renderer.js`](js/gl/renderer.js)), ~450
lines, no libraries.

Every visible object is one instanced quad evaluated by a signed distance
function in the fragment shader — circle, ring, regular n-gon, beam, spark. No
textures, no sprite atlas, no image assets anywhere in the repo. The entire
frame is a single `drawArraysInstanced` call regardless of how many hundreds of
enemies, bullets and particles are on screen.

Forward motion is sold entirely by three parallax star layers whose depth drives
both speed and brightness, with the nearest layer drawn as streaks rather than
points.

Colours are written to an `RGBA16F` target with values deliberately **above
1.0**. A bright-pass, two separable gaussian blurs at half and quarter
resolution, and an additive composite turn that overshoot into bloom. That HDR
overshoot is where the neon comes from: a colour of 3.5 doesn't clamp to white,
it *spills*. If `EXT_color_buffer_float` is missing the renderer falls back to
8-bit targets — bloom still works, just tamer.

UI is HTML/CSS rather than canvas: crisper text, real touch targets, and
responsive layout for free. The world's centre is offset by however much screen
the UI is covering, so opening the upgrade sheet on a phone slides the bastion
up instead of hiding it behind the panel.

Performance: object pools for every entity type (steady-state allocation is
essentially zero), DPR capped at 2, DOM refreshed at ~12Hz instead of per-frame,
and bloom intensity drops automatically if the frame rate falls below ~44fps.

Audio is synthesised at runtime with WebAudio — oscillators, one noise buffer,
and a master compressor. No audio files.

---

## Layout

```
index.html            markup + UI shell
css/ui.css            holographic UI, mobile-first
js/main.js            boot, main loop, event wiring
js/gl/renderer.js     WebGL2 instanced SDF renderer + bloom
js/game/balance.js    every tunable number; imported by the harnesses
js/game/game.js       simulation: ship, autopilot, waves, combat, loot
js/game/sectors.js    zone table — palette, hazards and rule twists
js/game/state.js      save/load, run vs. meta split
js/ui/hud.js          DOM layer
js/audio/synth.js     procedural WebAudio
tools/simulate.mjs    balance harness  — is the progression curve any good?
tools/headless.mjs    loop smoke test  — does the real game actually run?
tools/devserver.py    no-cache static server for local development
```

## Development

Nothing to install and nothing to build. Serve the directory and open it:

```bash
python3 tools/devserver.py 8732 .
```

Check the progression curve after changing any constant in `balance.js`:

```bash
node tools/simulate.mjs --runs 24
```

Sweep the most sensitive constant:

```bash
node tools/simulate.mjs --sweep --runs 18
```

Smoke-test the real game loop after changing anything in `js/game/` — this one
imports `game.js` itself and drives `Game.update()` at a fixed timestep, so it
catches stalls, NaN leaks and exhausted pools that a balance model cannot:

```bash
node tools/headless.mjs --waves 40
```

It exits non-zero on failure. To measure how deep an unaided run actually gets
(the keep-alive is disabled, so the ship dies for real):

```bash
node tools/headless.mjs --waves 400 --natural
```

---

MIT. Built with [Claude Code](https://claude.com/claude-code).
