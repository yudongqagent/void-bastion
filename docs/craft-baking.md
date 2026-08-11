# Realistic craft: baked depth, not more texture

## Why the last pass did not get there

Materials gave surfaces grain, roughness and a real tangent normal. It was not
enough, and the reason is structural rather than a matter of resolution.

Sky Force Reloaded's craft are **pre-rendered 3D models**. Every panel line is
geometry. The shading is baked from a mesh: ambient occlusion in the recesses,
contact shadows where a wing meets a fuselage, a silhouette with genuine
foreshortening, and a specular response that comes from a modelled surface.

Ours are flat SDF primitives — bars, polygons, slabs — drawn additively into a
single plane. Consequences, all visible:

* **Nothing occludes anything.** A wing crossing a fuselage adds its colour to
  it. Overlaps get *brighter*, when physically they should get darker.
* **There is no height.** No part is above any other, so there is no contact
  shadow, no cavity, no depth cue at all.
* **Nothing casts a shadow.** Craft and terrain sit in the same plane. This is
  the single largest cue Sky Force has that we do not: their aircraft throw a
  soft shadow onto the water below, which is what makes them read as *flying*.
* **Tiling texture is generic.** A repeating panel grid does not know where the
  craft's edges, intakes or spine are, so detail floats over the shape instead
  of belonging to it.

More texture cannot fix any of these four. They are all consequences of having
no third dimension.

## Approach: bake the craft, the way they did

Add height to the existing recipes and **render each craft class offline** into
a sprite with lighting information baked in. The recipes stay the single source
of truth; the baker is just a second consumer of them, alongside the live
renderer and the wreckage system.

`tools/genbake.mjs` rasterises each craft into a height field and derives
everything from it:

| output | derived from |
|---|---|
| coverage / alpha | union of all parts |
| albedo | the part's material, sampled in the craft's own frame |
| tangent normal | Sobel of the height field |
| ambient occlusion | how much of the local hemisphere the height field blocks |
| contact shadow | 2D ray march along the light direction against the heights |
| emissive | the recipe's `dot` parts — running lights |

Two things matter about this list. Occlusion and contact shadow are exactly what
the live renderer *cannot* compute, because they need to know about parts that
are not the one being drawn. And because the normal is baked rather than the
final shade, the craft still lights dynamically at runtime — the highlight
sweeps as it banks, instead of being frozen into the sprite.

### Rounded cross-sections

A box extruded to a flat height still reads flat. Each primitive gets a profile:

```
bar   capsule with a cylindrical cross-section — h rises toward the spine
gon   dome — h = base + rise * sqrt(1 - (d/r)^2)
slab  box with a chamfered edge
```

This is most of what makes the difference between "a shape with a normal map"
and "an object". A fuselage bar becomes a tube; a cockpit gon becomes a blister.

### Height assignment

Heights come from what a part *is*, not from a hand-authored number per part:
centreline parts sit high (spine, fuselage), off-centre parts sit low (wings,
sponsons), and `dot` lights sit on top of whatever they are mounted to. That
keeps all 21 recipes working untouched, and the heuristic is one function to
tune rather than 150 numbers to maintain.

## Drop shadows

Every flying craft draws its own alpha mask again, offset down-right, in near
black at low alpha, *before* the craft. Ground emplacements get a tight offset
(they are on the deck); flyers get a large one (they are not).

This is cheap — one extra quad per craft, no new texture — and it is the biggest
single realism win available, because it is the cue that separates a flying
object from the surface under it.

## Renderer changes

A new `SPRITE` shape samples the craft atlas. `renderCraft` collapses from a
loop over 4–9 primitives to **one** quad, plus the genuinely dynamic layers that
must stay live: shield rings, orbiting nodes, and the pulsing accent lights.

Fewer draw calls, and the game is fill-rate bound, so overlapping parts that
each shaded independently becoming one textured quad is a net *win* despite the
texture fetches.

## Costs

Craft atlases at 5x5 x 256px add roughly 1.5 MB to the existing 3.4 MB. The
loader, cache and progress bar already handle this and need no changes; the
untextured fallback still runs if they never arrive.

## Test plan

1. Baker is deterministic; `--check` diffs against committed output.
2. Assert every craft's alpha coverage is between 8% and 75% of its tile — a
   blank bake and a solid square are both silent failures.
3. `tools/headless.mjs` green.
4. `tools/e2e.html` in a real browser: atlases load, shaders link, loop lives.
5. Visual: the staged craft board, compared against the current build.
6. Seeded career bit-identical. None of this touches simulation.
