# Materials and textures

Design doc for giving the game real surface detail. Written before
implementation.

## The problem

Every solid surface in the game is a flat colour multiplied by one Lambert term
computed from a *fake* normal — the fragment's own position, treated as if the
shape were a sphere. That is why craft read as coloured cardboard cut-outs: at
any size, from any angle, a hull plate is a smooth gradient with no incident
detail. There are no panel lines, no rivets, no wear, no specular break-up, and
nothing that changes as the light moves relative to the surface.

Colour alone also has to carry far too much: archetype identity, faction, damage
state and material are all encoded in one RGB triple.

## Approach: generate, do not hand-author

Textures are produced by `tools/gentex.mjs`, a zero-dependency Node script that
writes PNGs directly (deflate via `node:zlib`, CRC32 and chunk framing by hand).

This is deliberate, and the reason is reproducibility rather than repo size:

* every material is a *function* — change one constant, regenerate, and the
  whole set stays coherent
* the generator is diffable and reviewable; a binary blob is not
* it is seeded, so regeneration is byte-identical and the cache key is stable
* no asset pipeline, no dependencies, no build step for players

The PNGs *are* committed. Players download images, not a generator.

## What gets generated

Two 1024×1024 atlases, each a 4×4 grid of 256px tiles. All tiles are tileable:
noise wraps modulo the tile, so a uv scale above 1 does not seam.

**`tex/material.png`** — RGB albedo detail, A ambient occlusion
**`tex/surface.png`** — RG tangent normal, B roughness, A metalness

Sixteen materials, chosen to cover every surface class the game actually has:

| # | material | where |
|---|---|---|
| 0 | painted plate | fighter fuselage — panel lines, rivet rows |
| 1 | brushed steel | bare structural spars |
| 2 | carbon weave | modern interceptor shells |
| 3 | worn plate | veteran craft — chipped paint over primer |
| 4 | ceramic armour | heavy hulls — tiled plates, chipped corners |
| 5 | military camo | bombers, transports |
| 6 | oxidised iron | derelicts, pirate craft |
| 7 | dark composite | stealth craft |
| 8 | canopy glass | cockpits |
| 9 | engine grille | intakes, exhausts — deep louvres |
| 10 | thermal foil | crumpled gold blanket, greebling |
| 11 | concrete | ground bases and pads |
| 12 | rock | reefs, island cliffs |
| 13 | sand | island shore |
| 14 | scorched metal | wreckage, damaged hulls |
| 15 | hazard stripe | warning chevrons on heavy units |

Each is built from the same primitive kit: tileable value-noise fBm, Worley
cells, jittered panel-line grids, rivet placement along panel edges, directional
scratch fields, and edge-wear masks derived from the height field. The kit is
what keeps sixteen materials looking like one art direction.

## Renderer changes

The instance layout grows from 12 floats to 14: a `a_mat` vec2 carrying
`(materialId, uvScale)`. At 24000 instances that is 1.3 MB of upload buffer,
against 1.1 MB today.

Lighting stops faking the normal. With a real tangent normal:

```
N = normalize(vec3(n.xy * strength, 1.0))    // rotated into the shape's frame
L = normalize(vec3(KEY_LIGHT, 0.55))
diffuse  = ambient + (1 - ambient) * max(dot(N, L), 0)
specular = spec(roughness) * pow(max(dot(N, H), 0), shininess(roughness))
rgb     *= albedo * ao * diffuse
rgb     += specular * (metal ? albedo : white)
```

This is the payoff: a scratch across a hull now *catches the light* and slides
as the craft banks, because the highlight is driven by a real surface normal
rather than by distance from the shape's centre.

Material id 255 means "untextured" — glows, sparks, rings and every particle
keep exactly their current path, so the neon effect layer is untouched.

## Loading and caching

Two 1024×1024 PNGs land at roughly 1.5–2.5 MB together. That is far too much to
block a first frame on without saying anything, so:

1. A boot overlay shows a real progress bar driven by `Content-Length` and
   streamed chunks — not a fake animation.
2. Decoded images go into the **Cache Storage API**, keyed by a content hash in
   the filename (`material.<hash>.png`). Repeat visits are a cache hit and never
   touch the network; a regenerated atlas gets a new name and misses cleanly, so
   there is no stale-asset problem and no cache-busting query strings.
3. **The game starts without them.** Textures are optional: the renderer boots
   with a 1×1 white fallback bound, and the atlas is swapped in when it arrives.
   A slow connection means a plain-shaded first few seconds, never a blocked
   game. This also means an asset 404 degrades instead of breaking.

## Risks

**Fill rate.** The game is fill-rate bound, not CPU bound. Two extra texture
fetches per fragment on solid shapes is real cost. Mitigation: only solid shapes
sample (glows and particles, the overwhelming majority of overdraw, do not), and
material sampling becomes the next rung on the existing adaptive quality ladder.

**Balance.** None of this touches simulation. The instance layout change is
mechanical. Expect the seeded career to be bit-identical; anything else is a bug.

## Test plan

1. `tools/gentex.mjs --check` regenerates and verifies the PNGs are byte-identical
   to what is committed, so the images and the generator cannot drift apart.
2. Decode every generated PNG back and assert dimensions, and that no tile is
   uniform (a silently-blank material is the likely generator failure).
3. `tools/headless.mjs` passes — the stub renderer ignores materials.
4. `tools/e2e.html` in a real browser: shaders still link with the sampler
   uniforms, textures load, progress reaches 100%, and the loop survives.
5. Seeded career bit-identical to baseline.
