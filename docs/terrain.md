# The map

## What is actually wrong

The capture says it plainly: the world is **convex polygons floating on a
plane**. Every landmass is a heptagon with a concentric sand ring, every
landmass is isolated from every other, and nothing connects to anything.

Point by point against the reference:

| | Sky Force Reloaded | Ours |
|---|---|---|
| coastline | organic, irregular, bays and headlands | a 7-sided polygon |
| land shape | continuous terrain the level flies over | isolated plates on water |
| beaches | a band where land meets sea, varying width | a concentric ring at a fixed 1.05x radius |
| relief | cliffs, valleys, visible elevation | everything at one height |
| linear features | roads, rivers, runways threading the map | none |
| settlement | buildings clustered into bases and villages | props scattered at random offsets |
| detail hierarchy | landmass, then fields/forest, then buildings | one scale of blob, one scale of prop |
| ground cover | forest masses, fields, bare rock, all distinct | one tiled rock texture everywhere |
| water margin | surf, shallows, river mouths, docks | a translucent ring |

The root cause is structural. `makeIsland` builds 3-5 convex lobes and draws
each as `polyLit`. A convex polygon cannot produce a bay, so it cannot produce
a coastline, so the map can never read as land no matter what texture goes on
it. This is the same mistake as the craft: the *shape* carried no information
and I kept improving the surface.

## The fix: a heightfield, not shapes

Replace the polygon lobes with a **continuous scrolling heightfield** sampled on
a grid, exactly the way a real terrain renderer works.

```
h(x, worldY) = fbm(...)          // one deterministic field, infinite in y
h < SEA           -> open water, draw nothing, the water plane shows
h < SHORE         -> beach
h < GRASS         -> grassland
h < ROCK          -> forest / scrub
h >= ROCK         -> bare rock, high ground
```

Each land cell is one lit quad carrying the material for its band. Three
properties fall out for free, and all three are the things the polygons could
never do:

* **Organic coastlines.** The waterline is a contour of the field, so it makes
  bays, spits, headlands and inlets on its own.
* **Relief.** Cell brightness tracks height, so slopes shade and high ground
  reads as high ground.
* **Continuity.** There is one field, so a landmass can run off one edge of the
  lane and come back — the world stops being a series of islands.

Feathering the alpha over the first few units above sea level gives a soft wet
margin instead of a hard polygon edge, and cells sitting just above the
waterline get a surf highlight.

### Linear features

A second low-frequency ridge function carves **rivers** (where it cuts below sea
level through land) and **roads** (a bright graded line following a contour).
Both are what turn terrain into somewhere people live.

### Settlement

Structures stop being placed at random offsets from a feature centre. They are
placed where the field is **flat, above the shore, and near a road**, which is
where buildings actually go, and clustered rather than sprinkled.

## Cost

A 32px grid over a 390x844 lane is 12 x 16 cells plus margin, of which roughly a
third are land — around 70 extra quads against a current frame of ~257. The
renderer is fill-rate bound and these are small opaque quads, which is the
cheapest thing it draws.

## Verification

* Screenshot before and after at 390x844.
* Coastline complexity: perimeter-to-area ratio of the land mask, which a
  polygon cannot raise and a heightfield contour will.
* Terrain must stay stable frame to frame — the same class of bug as the
  whitecaps, so it gets the same probe.
* Headless and e2e green, career unchanged.
