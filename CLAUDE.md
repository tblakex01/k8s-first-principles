# CLAUDE.md

Guidance for Claude Code (and other agents) working in this repository.

## What this project is

A **single, self-contained, dependency-free** browser simulation of Kubernetes
bin-packing and memory-pressure-driven eviction. The whole point is that the
failure behavior (eviction/OOM **cascades**) is *emergent* — it falls out of a
tick-based state model that encodes real mechanisms, not a scripted timeline or
canned animation. Treat that property as the project's north star: any change
that hardcodes an outcome, a sequence, or a "for demo effect" shortcut is a
regression, even if the animation looks the same.

## Architecture

The deliverable `index.html` is **built**, not hand-edited. Source lives in `src/`:

| File | Role | Environment |
|------|------|-------------|
| `src/engine.js` | Pure simulation engine — all dynamics live here. No DOM, no wall clock, seeded RNG. | Browser (`window.KSim`) **and** Node (`module.exports`) |
| `src/ui.js` | Rendering + input wiring only. Reads engine state, draws it, routes slider/preset changes back via `sim.setParams`. Contains **no dynamics**. | Browser |
| `src/head.html` | `<head>`: `<title>`, all CSS (theme-aware, light/dark). | — |
| `src/body.html` | Page body markup + the "Model documentation" `<details>` section. | — |
| `src/build.mjs` | Concatenates the parts into `index.html` (and `dist/artifact.html`). | Node |
| `src/verify.mjs` | Headless verification harness — asserts the emergent claims. | Node |

`index.html` and `dist/artifact.html` are generated artifacts. **Never edit them
by hand** — edit the `src/` parts and rebuild.

## Core invariants — do not break these

1. **Determinism.** Same seed ⇒ identical run. The engine uses a seeded
   `mulberry32` RNG and stable per-slot trait hashes (`hash01`). Do not
   introduce `Math.random()`, `Date.now()`, or any wall-clock/order-dependent
   state into the engine. `src/verify.mjs` asserts identical counters across
   two runs at the same seed.
2. **Emergence, not scripting.** A cascade must only ever be a consequence of
   the tick pipeline. No timers that "schedule" a kill, no pre-baked event
   lists. If you want a behavior to appear, encode the *mechanism* that causes
   it.
3. **Engine/UI separation.** All state transitions happen in `src/engine.js`.
   `src/ui.js` may read state and call `setParams`/`injectLeak`/`tick`, but must
   not mutate simulation state directly.
4. **Requests vs. usage split.** The scheduler sees only *requests*; the kernel
   and kubelet see *working set*. This gap is the engine of the cascade — keep
   the two views distinct.
5. **Ground truth over convenience.** Where real Kubernetes behaves a specific
   way (allocatable formula, `oom_score_adj` per QoS, eviction victim ranking,
   MemoryPressure taint + transition period), match it. Where you simplify,
   document it in `MODEL.md` with a justification.

## Commands

```bash
node src/build.mjs      # regenerate index.html and dist/artifact.html from src/
node src/verify.mjs     # run the headless verification harness (exits non-zero on failure)
```

There is no package.json/toolchain to install — plain Node ≥ 16 and any browser.

## Definition of done for engine changes

After any change to `src/engine.js` (or params that affect dynamics):

1. `node src/verify.mjs` passes all assertions (cascade forms under overcommit,
   vanishes at limit ratio 1.0, kernel OOMs collapse when thresholds rise,
   converges when demand fits, determinism + seed robustness).
2. `node src/build.mjs` regenerates the built files and they are committed.
3. If you touched a mechanism, update `MODEL.md` (rules table + ground-truth
   table) so the docs stay truthful.

If you can't confirm a claim, say so — don't assert it. The verify harness
exists precisely so behavioral claims are demonstrated, not hand-waved.

## Documentation map

- `README.md` — landing page / quick start / feature overview.
- `MODEL.md` — the authoritative spec: state-update rules, the cascade feedback
  loop, the ground-truth-vs-model table, and every deliberate simplification.
- In-app: the "Model documentation" `<details>` at the bottom of the page
  mirrors `MODEL.md` for readers who only have the HTML file.

## Conventions

- Vanilla JS, no build step beyond concatenation, no runtime dependencies.
- Memory is measured in **Mi** throughout the engine.
- Colors come from a validated, colorblind-safe, theme-aware palette; QoS
  classes have fixed hues (Guaranteed / Burstable / BestEffort). Don't recolor
  by rank or introduce a 9th categorical hue.
- Keep the whole thing openable as a `file://` URL with no server and no
  network — that portability is a feature.
