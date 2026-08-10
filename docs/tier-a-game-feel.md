# Tier A — game feel

Design doc for the four highest-leverage changes to how it *feels* to destroy
something. Written before implementation, to be reviewed and argued with.

## The problem, stated precisely

Killing an enemy currently produces: a colour-swapped radial particle burst, one
flash sprite, a synth blip, and the craft vanishing on the same frame it died.
That is the entire response, and it is identical for a 0.14× Mite and a 14×
Juggernaut apart from particle count.

Three specific things are missing, and they compound:

1. **No punctuation.** The simulation never pauses, so nothing reads as an
   *impact* — only as a state change.
2. **No consequence.** The craft is simply gone. Nothing falls, burns, or hits
   the water we spent a whole terrain layer building.
3. **No proportionality.** A shot removing 2% of a hull looks exactly like one
   removing 60%, so the player cannot feel their damage upgrades landing.

Everything below targets those three.

## Non-goals

* Not touching balance. No damage, hull, cost or scaling number changes. If
  something here alters measured run depth, that is a bug, not a feature.
* Not adding new enemy types, weapons or systems.
* No new asset pipeline. Still zero textures; everything composes from the
  existing five SDF primitives.

---

## 1. Hitstop and boss slow-motion

### Design

A short, global simulation freeze on significant impacts. Rendering continues,
so the player sees a held frame at the moment of the kill — this is what turns a
state change into a hit.

```
freeze duration = base(significance) / sqrt(timeScale)
significance    = clamp(enemy.maxHp / (enemyHP(wave) * 2.5), 0, 1)
```

| event | freeze |
|---|---|
| ordinary kill | 0.018s + 0.055 × significance |
| elite kill | above × 1.5 |
| bomber detonation | 0.05s |
| player takes a capped hit | 0.07s |
| boss death | slow-motion, not freeze (below) |

Dividing by `sqrt(timeScale)` matters: at 4× speed a fixed 60ms freeze is 240ms
of game time and reads as a stutter. Freezing in *real* seconds while the world
runs faster needs the duration pulled down.

**Boss death** gets slow-motion instead — `timeScale × 0.3` ramping back over
1.1s. A freeze on a boss is a hiccup; a ramp is a victory lap.

### Budget

Uncapped hitstop turns a screen-clearing Nova into a slideshow. Two limits:

* single freeze clamped to **0.09s**
* a rolling budget: at most **0.16s of freeze per second of real time**,
  refilled continuously. Kills that exceed it still play their other feedback,
  they just do not stop the clock.

### Integration

`Game.update(dtRaw)` gains an early branch. Feedback decay and the freeze timer
still run, so shake and flash continue to animate during the hold — a frozen
frame with a moving screen shake looks intentional; a completely static frame
looks like a dropped frame.

### Risk

Both harnesses drive `update()` at a fixed step. Freezing makes some steps
no-ops, which changes how much sim time a given number of iterations covers.
`tools/headless.mjs` must not regress, and the career numbers must land within
noise of the current figures. If freeze meaningfully changes measured depth, the
budget is wrong.

---

## 2. Silhouette-driven wreckage

### The key idea

`renderCraft()` already describes every craft as a list of parts in a local
frame where +y is the heading and the unit is the craft's radius. Those recipes
are currently imperative code inside a `switch`. Converting them to **data**
means one description drives two things:

* the living craft, drawn exactly as it is now
* its wreckage, where each part becomes an independent falling body

This is the whole point. We already model a Juggernaut as layered plates and a
Sniper as a rail spine — the death should show you that, not a generic puff.

### Data shape

```js
CRAFT.drone = [
  { t: 'bar', a: [0, -0.85], b: [0, 1.05], w: 0.30, m: 1.05 },
  { t: 'bar', a: [-1.05, -0.45], b: [0, 0.15], w: 0.22, m: 0.85 },
  { t: 'bar', a: [1.05, -0.45], b: [0, 0.15], w: 0.22, m: 0.85 },
  { t: 'dot', p: [0, 0.40], r: 0.24, m: 2.10, accent: true },
];
```

`renderCraft` becomes a loop over the recipe. Identical output — this is a pure
refactor, and it should be verified as such before wreckage is built on top.

### Wreck bodies

On death each part spawns a `wreck` with:

* world position of the part's local centre
* velocity = enemy velocity + outward impulse from the craft centre + jitter
* angular velocity proportional to how far off-centre the part was
* `alt` from 1 → 0 over its life, driving `scale = 0.55 + 0.45·alt`, which reads
  as falling away from the camera
* `burn` for the trailing fire and smoke, hottest on the piece that held the
  accent light

Small craft (Mite, and anything under ~9px radius) skip wreckage and keep the
current puff. A cloud of chaff producing forty tumbling parts is noise, not
spectacle, and it is the worst case for fill rate.

### Pool and budget

New `wreck` pool, 200 slots, one draw primitive each. Worst realistic case is a
Nova clearing ~40 craft: capped by the pool, and older wrecks are recycled
first. Roughly +120 primitives at peak against a current ~700, which the
adaptive quality ladder already has headroom for.

---

## 3. Damage-scaled impact

Everything about a hit scales with `frac = amount / enemy.maxHp`.

| response | scaling |
|---|---|
| hit flash | `0.08 + 0.14·frac` seconds, intensity `0.6 + 1.2·frac` |
| spark count | `1 + round(6·frac)` |
| knockback | render-space recoil `min(9, 62·frac)` px along the projectile's travel |
| screen shake | only above `frac > 0.25`, at `2 + 6·frac` |
| damage number | shown above `frac > 0.06` — currently a flat 12% dice roll |

Knockback needs the impact direction, which `damageEnemy()` does not currently
receive. Adding an optional direction argument is the only signature change;
callers without one (laser, arc, flak) pass nothing and get no knockback, which
is correct — a beam should not shove things.

Ground emplacements and bosses get knockback ×0.15 — bolted-down things should
shudder, not slide.

**Why this matters beyond polish:** it is the only channel through which the
player can *perceive* a damage upgrade. Right now Plasma Yield going 3.26K →
3.34K changes a number on a card and nothing else on screen.

---

## 4. Terrain interaction

### `Terrain.surfaceAt(x, y) -> 'water' | 'land'`

Approximates each feature with circles: island lobes, base pads and the base
platform, convoy hulls, reef rocks. Cheap, and only called on wreck impact —
never per frame per entity.

### Impact

When a wreck's `alt` reaches 0:

* **water** — expanding ring, a short-lived white foam disc, 4–6 droplet sparks
  arcing outward, low splash sound
* **land** — dark scorch that fades over ~2.5s, dust puff, sharper impact sound

Debris that leaves the bottom of the lane before landing is simply recycled.

This closes the loop on the terrain layer: right now the ground is scenery that
nothing ever touches, which is precisely why it reads as a backdrop instead of a
place.

---

## Shared concerns

**Performance.** We established the game is fill-rate bound, not CPU bound
(0.10 ms/frame simulation against a 16.7 ms budget). Wreckage adds primitives,
not logic. The adaptive quality ladder already sheds wide bloom then resolution;
wreck count becomes the third thing it sheds if frames get expensive.

**Accessibility.** `prefers-reduced-motion` already zeroes CSS animation. It
should also halve hitstop and disable slow-motion — freezing the screen is
exactly the class of effect that setting exists for.

## Test plan

1. `tools/headless.mjs` passes, including the existing NaN and pool assertions.
2. A new assertion: wrecks spawn, land, and the pool never exhausts.
3. Career over 6 prestiges lands within noise of the current level 17 → 43.
   Any real movement means hitstop is stealing sim time.
4. Visual: one capture per craft class mid-death, to confirm the wreckage
   actually reads as that craft coming apart.

## What the implementation actually found

Point 3 turned out to be untestable as written, and fixing that was the most
valuable part of the work.

**Cosmetics were sharing the gameplay RNG.** Adding any effect that calls
`Math.random()` re-samples every subsequent gameplay roll. A pure on/off A/B
therefore compares two different worlds, and the measured spread from that alone
was up to 9 levels — far larger than any effect we were trying to detect. Every
"does this change balance?" question was unanswerable.

Fixed with `Game.fxRandom()`, a dedicated stream for wreckage, explosions,
sparks, muzzle flash and thrust. With it in place, Tier A on vs off is
**bit-identical across seeds 11, 12 and 13** — neutrality is now proven rather
than argued from averages.

**Knockback was a real regression, and only visible once the noise was gone.**
Isolated, hitstop was bit-identical while knockback cost 15–25% of run depth
(seed 13: level 40 → 29). Moving enemies up-lane stretched waves past the
enrage timer, so survivors turned hostile. Knockback is now a **render-space
offset**: the craft is drawn displaced and springs back, while collision,
targeting and spawning all see the true position. Identical on screen, inert in
the simulation.

The general lesson: a feel change that touches entity positions is a balance
change. Draw it, do not move it.

## Decisions (resolved at review)

1. **Hitstop strength — punchy.** 18–73ms scaled by enemy size, budget 0.16s
   per real second. Clearly felt on heavy kills, near-invisible on chaff, and
   safe to leave running unattended.
2. **Boss slow-motion — on, but auto-skipped above 2× speed.** The ramp is a
   victory lap at 1–2×; at 4× it would be three seconds of wall clock every
   level, which is a cost the idle player never asked to pay. Above 2× the boss
   gets staged detonations and no time dilation.
3. **Wreck lifetime — ~1.4s, falling to the surface.** Long enough to splash or
   scorch, which is the whole reason the terrain layer exists.
4. **Knockback on the swarm — capped.** At most 6 enemies receive a knockback
   impulse per frame, highest-damage first. A wall of thirty craft recoiling in
   unison reads as the formation breathing, not as impact.
