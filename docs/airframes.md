# Airframes: strategy and plan

## Honest diagnosis

Three passes have now gone into how craft are *shaded* — materials, then baked
depth with AO and contact shadows. Each was a real improvement and none of them
fixed the actual problem, because the problem is not shading.

**The median craft is six parts, and most of them are capsules.** A drone is
three bars and a light. A mite is one bar and a light. Baking ambient occlusion
onto a stick figure produces a very well-lit stick figure.

Measured, current part counts:

```
mite 2   wraith 3   shielder 3   drone 4   darter 4   bomber 4   warden 4
splitter 5   sniper 5   turret 5   lancer 6   juggernaut 6   tank 6
gunship 7   warship 7   sam 7   brute 8   sentinel 8   dread 8
radial 10   boss 11
```

For comparison, one Sky Force Reloaded fighter reads as: nose cone, canopy
blister, tapered fuselage, swept wings with distinct leading and trailing edges,
wingtip pods, two engine nacelles with intake lips and lit exhaust nozzles,
tailplanes, a vertical fin, underwing pylons with visible ordnance, painted
livery with panel variation, an insignia, and warning chevrons at the intakes.
That is roughly **20-30 distinguishable features**, not six.

Two further problems, both mine:

* **The player ship was never baked.** It is drawn with raw `beam` and `glow`
  calls in saturated cyan with an additive plume — the most literal "glowing
  colour block" on the screen, and the one the player looks at constantly.
* **Additive glow washes out form.** Every craft carries an engine glow, a lamp
  glow and bloom on top. Sky Force puts almost no bloom on airframes; it spends
  it on exhaust and weapon fire, so hulls stay solid and readable and the bright
  things actually read as bright.

## Strategy

Fix the geometry first, then the paint, then stop washing it out. In that order,
because each step is wasted if the one before it is wrong.

### 1. An airframe vocabulary, not a pile of capsules

The recipe language gains primitives that describe aircraft anatomy. Each has a
height profile, so the baker gets real volume rather than extruded flatness.

| primitive | what it is | height profile |
|---|---|---|
| `loft` | tapered fuselage from a spine of stations `[y, halfWidth, height]` | elliptical cross-section, interpolated along the spine |
| `wing` | a quad with root chord, tip chord, span and sweep | airfoil — thick at the leading edge and root, thin at tip and trailing edge |
| `nacelle` | engine pod | tube, with a recessed intake lip at the front and a nozzle at the back |
| `canopy` | glazed blister | dome, forced to the glass material |
| `fin` | vertical surface | thin, tall, sits above everything |
| `pylon` | underwing hardpoint | small box, low |
| `store` | ordnance on a pylon | capsule, hangs below the wing |
| `dot` | running light | emissive lamp, unchanged |

`mirror: true` on a part emits its x-mirrored twin, so a wing pair, nacelle pair
and pylon pair each cost one line. This is what makes 25-part craft affordable
to author and to read.

`loft` is the single highest-value addition. A tapered fuselage with an
elliptical cross-section — narrow at the nose, full at the wing root, tapering
to the tail — is most of what makes a shape read as an aircraft instead of a
sausage.

### 2. Re-author all 22 airframes

All 21 enemy classes plus **the player ship**, which becomes a baked craft like
everything else. Target 16-28 parts each, with anatomy appropriate to the role:

* interceptors — long nose, small canopy, sharply swept wings, single nozzle
* gunships — broad fuselage, twin nacelles, stub wings, visible turrets
* bombers — deep belly, wide straight wings, four nozzles, bomb stores
* capital hulls — slab superstructure, sponsons, multiple turrets, deck detail
* emplacements — a base ring, a rotating housing, a barrel

### 3. Painted liveries, not a single tint

Today every craft is one hull colour multiplied over everything, which is why
they read as coloured blocks. Each class gets a **livery** baked in:

* a darker dorsal spine down the centreline
* lighter panels outboard, following the wing
* a contrasting nose band and tail band
* a squadron insignia — a roundel or chevron, placed on the wing
* warning chevrons at the intake lips
* soot streaking aft of the nozzles

Liveries multiply the material, so plating and panel lines still show through.
The hull tint still applies on top, so archetype colour coding survives.

### 4. Stop washing the form out

* Remove the additive hull glow from craft entirely.
* Keep exhaust bloom, but move it to the **nozzle** positions from the recipe
  rather than a blob behind the craft.
* Lamps stay small and additive rather than replacing the hull.
* Raise the bloom threshold so hulls stay under it and only exhaust, weapons and
  explosions spill.

### 5. Bake at higher fidelity

* Supersample 3x instead of 2x — the silhouettes are about to get much finer.
* Sharper normal derivation, and AO tightened so panel gaps read at small sizes.
* Bake a dedicated **nozzle mask** so exhaust can be drawn from the sprite's own
  geometry.

## Risks

**Authoring volume.** 22 craft at ~20 parts is the bulk of the work. Mitigated
by `mirror` and by shared builder helpers for common assemblies.

**Detail lost at 32px.** Real risk: a craft on screen is small. Detail must be
authored at *silhouette* scale — a visible notch in the wing, a nozzle that
breaks the outline — not as fine surface noise that dissolves. Every craft gets
checked at actual game size, not only in the showcase.

**Bake time and payload.** 3x supersampling at 22 craft is slower to generate;
the atlas itself stays the same size.

**Wreckage.** It reads `SOLID_PARTS` from the recipes. New primitives must be
mapped to wreck bodies or craft will stop shedding debris.

## Test plan

1. Every craft's part count is at least 14; assert it, so this cannot silently
   regress to stick figures.
2. Bake coverage stays in range, and a **new** check: silhouette complexity
   (edge-pixel count relative to area), which catches a blob with no features.
3. Wreckage still spawns for every class.
4. `headless.mjs` and `e2e.html` green; seeded career unchanged.
5. Visual: showcase board **and** a strip at true game size (16-34px radius),
   because that is the only size that matters.
