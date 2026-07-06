<div align="center">

# 📦 Bin-Pack &amp; Evict

### An emergent, first-principles simulation of Kubernetes bin-packing &amp; memory-pressure eviction

*Watch an eviction cascade form — then make it vanish by relaxing a single limit. Nothing is scripted.*

<br>

[![Kubernetes](https://img.shields.io/badge/Kubernetes-scheduling%20%26%20eviction-326CE5?logo=kubernetes&logoColor=white)](https://kubernetes.io/docs/concepts/scheduling-eviction/)
[![Vanilla JS](https://img.shields.io/badge/vanilla-JavaScript-F7DF1E?logo=javascript&logoColor=black)](src/engine.js)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](#-features)
[![Single file](https://img.shields.io/badge/deliverable-single%20HTML%20file-blue)](index.html)
[![Emergence](https://img.shields.io/badge/cascade-emergent%2C%20not%20scripted-8A2BE2)](MODEL.md)

[![Verified](https://img.shields.io/badge/behavior-verified%20✓-success)](src/verify.mjs)
[![Top language](https://img.shields.io/github/languages/top/tblakex01/k8s-first-principles)](https://github.com/tblakex01/k8s-first-principles)
[![Repo size](https://img.shields.io/github/repo-size/tblakex01/k8s-first-principles)](https://github.com/tblakex01/k8s-first-principles)
[![Last commit](https://img.shields.io/github/last-commit/tblakex01/k8s-first-principles)](https://github.com/tblakex01/k8s-first-principles/commits)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](https://github.com/tblakex01/k8s-first-principles/pulls)

<br>

**[▶ Quick start](#-quick-start) · [🧠 How it works](#-how-it-works) · [🔁 The cascade](#-the-feedback-loop-that-makes-a-cascade) · [🔬 Verification](#-emergence-proven-by-construction) · [📖 Model spec](MODEL.md)**

</div>

---

## 🌊 What is this?

Open **one HTML file** and watch a Kubernetes cluster tear itself apart — or hold
steady — depending on how you've tuned it. Pods request memory, get bin-packed
onto nodes, grow into their limits, trip kubelet's eviction thresholds, race the
kernel OOM killer, and get rescheduled onto already-pressured neighbors. When the
packing is too tight, that reschedule loop **cascades**: one node tips, its refugees
tip the next, and the wave propagates across the cluster.

The defining property: **the cascade is emergent.** Every tick advances a state
model that encodes the real mechanisms; there is no timeline, no canned animation,
no "for demo effect" scripting. Relax the limit-to-request ratio to `1.0×`, or raise
the eviction thresholds, and the cascade **dissolves for mechanistic reasons** — you
can see it in the sim and prove it headlessly.

> 💡 **The one-sentence mental model:** the scheduler books *requests*, but the kernel
> serves *usage* — and when `limit > request`, the gap between those two numbers is
> exactly the room a cascade grows into.

<div align="center">

| Overcommitted (`limit = 3× request`) | Right-sized (`limit = request`) |
|:---:|:---:|
| 🔴 nodes tip → evict → reschedule → tip again | 🟢 usage ≤ requests ≤ allocatable — nothing trips |
| **cascade forms** | **cascade cannot form** |

</div>

---

## ✨ Features

- 🧩 **Real scheduling** — requests-only bin-packing against the true allocatable
  formula `capacity − reserved − evictionHard`; MostAllocated (pack) / LeastAllocated
  (spread) scoring; `NoSchedule` taint filtering.
- 📈 **Per-pod working-set growth** — pods mean-revert toward a target fraction of
  their *limit*, throttled by a PSI-style reclaim stall. Optional memory leaks.
- 🧨 **Three distinct kill paths, faithfully modeled** — cgroup v2 `memory.max`
  container OOM (restart-in-place), kernel OOM by `oom_score_adj` per QoS class, and
  kubelet soft/hard eviction (evict-and-reschedule).
- ⚖️ **QoS-aware OOM selection** — Guaranteed `−997`, BestEffort `+1000`, Burstable
  by request ratio, exactly as kubelet sets them.
- 🕰️ **The kubelet/kernel race** — the kernel acts every tick; kubelet observes every
  10 s. Whether the kernel OOM-kills before kubelet can evict is an *outcome*, not a
  setting.
- 🎛️ **Live tuning** — node count, request/limit ratio, working-set targets, and every
  kubelet threshold, all adjustable while it runs.
- 📊 **Real-time visualization** — node occupancy (kernel view *and* scheduler view),
  per-pod memory stacks, animated reschedule arcs, a cluster-memory timeline, and a
  live event log.
- 🎲 **Deterministic** — seeded RNG; the same seed reproduces the same run exactly.
- 🔬 **Verified** — a headless harness asserts the emergent claims across parameter
  regimes and seeds.
- 📦 **Zero dependencies, single file** — no build to run it, no network, no install.
  Works from a `file://` URL.

---

## ▶ Quick start

```bash
# 1. Clone
git clone https://github.com/tblakex01/k8s-first-principles.git
cd k8s-first-principles

# 2. Open it — that's it. No build, no server, no dependencies.
open index.html          # macOS
xdg-open index.html      # Linux
start index.html         # Windows
```

Then drive it:

1. Let it run on the **Overcommitted bin-pack** preset and watch nodes go red as the
   cascade builds.
2. Drag **Limit : request** down to `1.00×` — as the rolling replacement completes,
   the cascade dies.
3. Hit **Inject leak** with a wide limit ratio and watch one pod drag its whole node
   into pressure.

### Verify the emergence yourself

```bash
node src/verify.mjs      # 15 assertions across 4 regimes + determinism/seed checks
node src/build.mjs       # regenerate index.html from src/ (only needed if you edit sources)
```

---

## 🧠 How it works

Each **tick = 1 simulated second**, and the engine runs this pipeline in order:

| # | Stage | What happens |
|:-:|-------|--------------|
| 1 | **Working-set growth** | `U += (T − U)/τ · s + ε` toward a per-pod target `T` (a fraction of the *limit*); `s` is a reclaim-stall throttle; leaky pods grow unbounded. |
| 2 | **cgroup v2 `memory.max`** | `usage ≥ limit` → container OOM-killed **in place**, CrashLoopBackOff `min(10·2ⁿ, 300)` s. |
| 3 | **Kernel OOM (every tick)** | node at capacity → kill highest `oom_score = 1000·usage/cap + oom_score_adj`, using kubelet's real QoS adj values. |
| 4 | **Kubelet eviction (every 10 s/node)** | `memory.available` under soft (grace-gated) or hard (immediate) threshold → evict by real victim ranking; set `MemoryPressure` taint. |
| 5 | **Controller** | evicted/drained pods get replacements after an informer delay; restarts *don't* reschedule, evictions *do*. |
| 6 | **Scheduler** | requests-only fit vs. allocatable, taint-filtered, MostAllocated/LeastAllocated scoring. **Never sees usage.** |
| 7 | **Telemetry** | PSI proxy, metrics history, event log. |

📖 **The full specification** — every formula, the ground-truth-vs-model table, and
each deliberate simplification with its justification — lives in **[MODEL.md](MODEL.md)**.

---

## 🔁 The feedback loop that makes a cascade

With `limit > request` and working sets that track limits, a bin-packed node hosts
more *demand* than it has physical memory. Then:

```
   working sets grow
          │
          ▼
  memory.available dips under a threshold
          │
          ▼
  kubelet evicts  ──(or the kernel OOM-kills first, if growth
          │            outran the 10s housekeeping loop)
          ▼
  eviction frees REQUESTS in the scheduler's books  +  taints the node
          │
          ▼
  controller creates a replacement pod
          │
          ▼
  scheduler — blind to usage — bin-packs it onto the
  next-most-committed untainted node
          │
          ▼
  replacement regrows toward the same target → tips THAT node
          │
          └──────────────── repeat ────────────────┘
```

Taints concentrate refugees onto ever-fewer nodes (accelerating the wave);
transition-period expiry can set up oscillation. The loop only ends when the *state*
makes it end — demand shed below capacity, pods parked Pending, or parameters that
keep usage inside requests.

---

## 🔬 Emergence, proven by construction

`node src/verify.mjs` runs the **same engine** the page uses and asserts that the
cascade appears and disappears purely as a function of the rules — **15 assertions,
all passing**:

| Regime | Parameters | Verified outcome |
|--------|-----------|------------------|
| 🔴 **Overcommitted bin-pack** | `ratio 3.0×`, targets `~75%` of limit | cascade active (≥6 kills / ≥3 nodes in 90 s), 54 evict→reschedule→kill chain links, kubelet evictions **and** kernel OOMs |
| 🟢 **Right-sized limits** | `ratio 1.0×` (Guaranteed) | **zero kills**, cascade cannot form — robust across 4 seeds |
| 🟡 **Early-eviction headroom** | soft `1536Mi` / hard `1024Mi` | kernel OOMs collapse `130 → 11`; failure mode shifts to orderly eviction |
| 🟢 **Overcommit that fits** | `ratio 3.0×`, targets `~45%` | transient churn, then fully quiet by tick 1200 |
| 🎲 **Determinism** | seed 42, twice | identical counters |
| 🎲 **Seed robustness** | seeds 7 / 1337 / 20260706 | cascade in the overcommit case, calm in the right-sized case, on every seed |

The built page was additionally driven in **headless Chromium** (zero console errors):
the cascade forms through the real UI and is **extinguished live** by dragging the
limit ratio to `1.0` mid-run.

---

## 🎛️ Live controls

<table>
<tr><td>

**Cluster**
- Node count
- Node RAM (capacity)
- Reserved (system + kube)

**Workload**
- Replicas
- Memory request
- Limit : request ratio
- Mean working set (of limit)
- BestEffort share
- Growth time constant
- Leak rate

</td><td>

**Kubelet eviction**
- Soft threshold + grace period
- Hard threshold
- Housekeeping interval
- Pressure transition period
- Max pod grace (soft)

**Scheduler**
- MostAllocated (bin-pack) / LeastAllocated (spread)

**Actions**
- ▶ Play / Step / speed (1×–60×)
- 🧨 Inject leak
- ⟲ Reset (new seed)

</td></tr>
</table>

Four one-click **presets** mirror the verification matrix, so you can jump straight to
a forming cascade — or a stable cluster — and start tuning.

---

## 🗂️ Project structure

```
k8s-first-principles/
├── index.html          # ← the deliverable: open this (built from src/)
├── MODEL.md            # authoritative model spec: rules, feedback loop, ground truth
├── CLAUDE.md           # guidance for AI agents working in this repo
├── README.md           # you are here
└── src/
    ├── engine.js       # pure simulation engine — all dynamics (browser + Node)
    ├── ui.js           # rendering + input wiring (no dynamics)
    ├── head.html       # <head> + theme-aware CSS
    ├── body.html       # page body + in-app model docs
    ├── build.mjs       # concatenates src/ → index.html
    └── verify.mjs       # headless verification harness
```

> ⚠️ `index.html` is **generated**. Edit the parts in `src/` and run
> `node src/build.mjs` — don't hand-edit the built file.

---

## 🧪 Deliberate simplifications

Honest about where the model simplifies (full rationale in [MODEL.md](MODEL.md)):

- **Memory-only** — one resource dimension; no CPU/pid/disk eviction signals.
- **Anonymous memory only** — no page cache. Safe because kubelet's
  `memory.available` already excludes reclaimable `inactive_file`, so signal
  semantics match.
- **PSI is a derived proxy** — shown per node, used only to stall allocation (real
  kubelets don't act on PSI either; it's still alpha there).
- **Watchable timing** — `pressure-transition-period` defaults to `60 s` (real default
  `300 s`) so oscillations are visible; the slider reaches `300`.

---

## 🤝 Contributing

The north star is **emergence**: behavior must fall out of the mechanisms, never a
hardcoded outcome. Before opening a PR that touches the engine:

1. `node src/verify.mjs` passes all assertions.
2. `node src/build.mjs` and commit the regenerated `index.html`.
3. If you changed a mechanism, update `MODEL.md` so the docs stay truthful.

See **[CLAUDE.md](CLAUDE.md)** for architecture, invariants, and conventions.

---

<div align="center">

**Built from first principles.** No mock data, no scripted cascade — just the rules,
running.

*If you find this useful for teaching Kubernetes scheduling &amp; eviction, a ⭐ is appreciated.*

</div>
