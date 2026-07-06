# Contributing to Bin-Pack & Evict

Thanks for your interest! 🎉 This project has one non-negotiable north star, and
a couple of small workflow rules that keep it intact.

## 🧭 The north star: emergence, not scripting

The whole value of this simulation is that the failure behavior (eviction/OOM
**cascades**) is an *emergent* consequence of a tick-based state model that
encodes real Kubernetes mechanisms. **Any change that hardcodes an outcome, a
sequence, or a "for demo effect" shortcut is a regression** — even if the
animation looks identical. If you want a behavior to appear, encode the
*mechanism* that causes it.

## 🏗️ Architecture in 30 seconds

The deliverable `index.html` is **built**, not hand-edited. Source lives in `src/`:

| File | Role |
|------|------|
| `src/engine.js` | Pure simulation engine — all dynamics. No DOM, no wall clock, seeded RNG. Runs in browser **and** Node. |
| `src/ui.js` | Rendering + input wiring only. No dynamics. |
| `src/head.html` / `src/body.html` | `<head>` (CSS) and page body markup. |
| `src/build.mjs` | Concatenates `src/` → `index.html` and `dist/artifact.html`. |
| `src/verify.mjs` | Headless verification harness. |

> ⚠️ Never hand-edit `index.html` or `dist/artifact.html` — they are generated.
> Edit the `src/` parts and rebuild.

See [`CLAUDE.md`](CLAUDE.md) for the full architecture and invariants.

## 🔧 Development workflow

No toolchain to install — just **Node ≥ 16** and any browser.

```bash
node src/build.mjs      # regenerate index.html + dist/artifact.html from src/
node src/verify.mjs     # run the headless verification harness (non-zero exit on failure)
```

## ✅ Definition of done (for engine changes)

Before opening a PR that touches `src/engine.js` or any dynamics:

1. **`node src/verify.mjs` passes all assertions** — the cascade forms under
   overcommit, vanishes at limit ratio 1.0, kernel OOMs collapse when thresholds
   rise, the cluster converges when demand fits, and determinism + seed
   robustness hold.
2. **`node src/build.mjs` was run and the regenerated `index.html` is committed.**
3. **If you changed a mechanism, `MODEL.md` is updated** (rules table +
   ground-truth table) so the docs stay truthful.

Docs-only or UI-only changes don't need the verify harness, but should still
build cleanly.

## 🧱 Invariants — don't break these

1. **Determinism** — same seed ⇒ identical run. No `Math.random()`,
   `Date.now()`, or wall-clock/order-dependent state in the engine.
2. **Emergence, not scripting** — no timers that "schedule" a kill, no pre-baked
   event lists.
3. **Engine/UI separation** — all state transitions live in `src/engine.js`;
   `src/ui.js` only reads state and calls `setParams`/`injectLeak`/`tick`.
4. **Requests vs. usage split** — the scheduler sees only *requests*; the kernel
   and kubelet see *working set*. This gap is the engine of the cascade.
5. **Ground truth over convenience** — match real Kubernetes where it behaves a
   specific way; document every simplification in `MODEL.md`.

## 🐛 Reporting bugs & 💡 requesting features

Use the issue templates. For a claimed behavioral bug, the most useful report
includes the **seed and slider/preset values** that reproduce it (the sim is
deterministic, so that fully specifies the run).

## 📜 Commit & PR etiquette

- Keep PRs focused; separate docs/UI changes from engine changes where practical.
- Reference the mechanism you're modeling and, if relevant, the ground-truth
  Kubernetes behavior you're matching.
- Be honest about what you verified. If you couldn't confirm a claim, say so —
  the verify harness exists precisely so behavioral claims are demonstrated, not
  hand-waved.

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
