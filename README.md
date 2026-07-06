# k8s-first-principles — bin-pack & evict

A single self-contained interactive simulation of Kubernetes bin-packing and
memory-pressure-driven eviction. Open **`index.html`** in a browser — no build,
no network, no dependencies.

Every tick advances a state model (requests-based scheduling, per-pod
working-set growth, cgroup v2 `memory.max`, kernel OOM scoring by QoS, kubelet
soft/hard eviction with grace periods and pressure taints, and the
controller/reschedule loop). Cascades are emergent consequences of those rules
— relax the limit ratio to 1.0× or raise the eviction thresholds live and
watch the cascade dissolve for mechanistic reasons, not scripted ones.

- `MODEL.md` — the state-update rules, the cascade feedback loop, ground-truth
  vs. model table, and the verified falsification matrix.
- `src/engine.js` — the pure simulation engine (browser + Node).
- `src/verify.mjs` — headless verification: `node src/verify.mjs` runs four
  parameter regimes plus determinism/seed-robustness checks (15 assertions).
- `src/build.mjs` — assembles `index.html` (and `dist/artifact.html`) from the
  parts in `src/`: `node src/build.mjs`.

Verified: engine assertions pass across seeds, and the built page was driven
in headless Chromium (zero console errors; cascade forms under defaults and is
extinguished live by relaxing limits).
