# ⬡ VOID BASTION

An infinite sci-fi idle tower defence for the browser. One bastion, an endless
machine swarm, and an upgrade tree that never stops paying out.

**Play:** https://yudongqagent.github.io/void-bastion/

No build step, no dependencies, no accounts, no tracking. Vanilla ES modules and
a hand-written WebGL2 renderer, served as static files.

---

## The loop

You never aim and you never place towers. The bastion at the centre of the
screen fires on its own; your job is deciding what to buy and when to walk away.

| | |
|---|---|
| ⬤ **Coins** | Drop from kills and wave clears. Spent during a run in **UPGRADES**. Lost when the run ends. |
| ◆ **Cores** | Earned by ascending. Spent in the **LAB** on permanent research that survives forever. |

Runs are *designed* to end. Enemy health grows exponentially with the wave
number while your in-run upgrades grow linearly, so every run eventually hits a
wall. That is the pacing mechanism, not a failure state — you ascend, convert
the depth you reached into Cores, and the next run starts stronger than the last
one ever was.

Every 10th wave is a boss. Every 25th pays a milestone bonus. Abilities unlock
in the Lab and fire from the bottom bar or the <kbd>1</kbd>–<kbd>5</kbd> keys.
Progress saves to `localStorage` automatically.

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
~wave 498, with no plateau and no runaway.

### Anti-stall

Sentinels hold at range and shoot instead of closing, so a bastion with strong
regen but not enough damage could sit in one wave indefinitely — neither winning
nor dying. After 100 seconds in a single wave the survivors **enrage**: they
speed up and hit harder without limit, and Sentinels abandon the standoff and
charge. The standoff always resolves.

---

## Rendering

A hand-written WebGL2 renderer ([`js/gl/renderer.js`](js/gl/renderer.js)), ~450
lines, no libraries.

Every visible object is one instanced quad evaluated by a signed distance
function in the fragment shader — circle, ring, regular n-gon, beam, spark. No
textures, no sprite atlas, no image assets anywhere in the repo. The entire
frame is a single `drawArraysInstanced` call regardless of how many hundreds of
enemies, bullets and particles are on screen.

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
js/game/game.js       simulation: entities, waves, combat, abilities
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

It exits non-zero on failure.

---

MIT. Built with [Claude Code](https://claude.com/claude-code).
