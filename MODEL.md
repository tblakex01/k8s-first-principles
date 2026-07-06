# Model documentation — bin-packing & memory-pressure eviction simulation

This documents the state model in `src/engine.js` (the same code embedded in
`index.html`). Everything the page shows is produced by these update rules
acting on state each tick. There is no scripted timeline; the RNG is seeded, so
a run is fully reproducible, and `src/verify.mjs` asserts the emergent claims
headlessly.

**Fidelity commitment:** memory is the only resource dimension, modeled at
1-second resolution, with the control loops that matter for pressure cascades
reproduced at their real cadences and formulas (below). CPU, disk/pid eviction
signals, affinity/topology scheduling, and page-cache dynamics are deliberately
out (see Simplifications).

## State

- **Node**: physical capacity, reserved (system+kube), committed requests
  (scheduler's books), set of bound pods, `MemoryPressure` condition (⇒
  `NoSchedule` taint), soft-signal first-observed time, derived signals
  (`workingSet`, `memory.available`, PSI proxy).
- **Pod** (one container): request `R`, limit `L = R·ratio` (ratio 1.0 ⇒
  Guaranteed; `R = L = 0` ⇒ BestEffort), per-pod working-set target `T` drawn
  as a fraction of the limit (default 75% ± 20%, capped at 92%), usage `U`,
  state ∈ {pending, running, backoff, terminating}, restart count, generation
  (incremented per replacement), leak flag.
- **Workload**: `replicas` controller-managed slots; a slot's QoS/leak traits
  are stable hashes of the slot index, so a leaky deployment leaks wherever its
  replacement lands.

## Tick pipeline (1 tick = 1 s, in order)

1. **Working-set growth.** Running pods: `U += (T − U)/τ · s + ε`,
   `ε ~ N(0, σ²)`, with `s = 1 − 0.6·PSI_full` a reclaim-stall throttle. Leaky
   pods additionally gain `leakRate` Mi/s without bound. Terminating pods drain
   linearly over their grace; backoff pods hold 0.
2. **cgroup v2 `memory.max`.** `U ≥ L` ⇒ container OOM-killed **in place**:
   usage → 0, CrashLoopBackOff delay `min(10·2ⁿ, 300)` s, restart, regrow. The
   pod stays bound — no reschedule.
3. **Kernel OOM (every tick).** If node working set (Σ pod usage + system
   daemons) ≥ physical capacity, kill the container with the highest
   `oom_score = 1000·U/capacity + oom_score_adj`, where adj uses kubelet's real
   values: Guaranteed −997, BestEffort 1000, Burstable
   `min(max(2, 1000 − 1000·R/capacity), 999)`. Same in-place restart path as
   rule 2. The kernel acting at 1 s while kubelet observes at 10 s is the race
   that decides hard-eviction vs OOM storms.
4. **Kubelet eviction manager (per node, every `housekeepingSec`, staggered).**
   Signal `memory.available = capacity − workingSet`.
   - hard threshold breached ⇒ evict one pod now, grace 0;
   - soft threshold continuously breached for the grace period ⇒ evict one pod
     with `min(pod grace, eviction-max-pod-grace-period)`;
   - victim ranking (real): usage-over-requests pods first (any BestEffort
     usage qualifies), then lower priority, then largest `U − R`;
   - either signal sets `MemoryPressure` ⇒ taint; held for
     `pressureTransitionSec` after the signal clears;
   - eviction marks the pod **Failed immediately**: its requests leave the
     scheduler's books while its memory is still draining — a real gap that
     lets replacements bind before the memory is actually free.
5. **Controller.** Evicted/drained pods get a replacement pod after an informer
   delay (`controllerDelaySec`). OOM restarts do **not** create replacements —
   that asymmetry is why leaks crashloop in place while evictions travel across
   the cluster. Pod specs are immutable: slider changes to request/limit/QoS
   roll the workload at `rollingMaxUnavailable` pods per tick.
6. **Scheduler.** Filter: untainted, pod count < 110, and
   `committed + R ≤ allocatable`, with the real allocatable formula
   `allocatable = capacity − reserved − evictionHard` (raising the hard
   threshold shrinks what may be booked). Score: MostAllocated (bin-pack,
   default) or LeastAllocated (spread). **Requests only — the scheduler never
   sees usage.** Unschedulable pods retry with backoff and are reported
   Pending with a reason (insufficient allocatable vs pressure taint).
7. **Telemetry.** PSI proxy per node
   (`PSI_some = clamp(1 − avail/(0.06·capacity))`, `PSI_full = PSI_some²`),
   metrics history, event log.

## The feedback loop responsible for the cascade

With `L > R` and working sets that track limits, a bin-packed node hosts more
*demand* than physical memory: the scheduler booked requests; the kernel serves
usage.

> growth pushes a packed node's `memory.available` under a threshold
> → kubelet evicts (or, when growth outruns the 10 s housekeeping cadence, the
>   kernel OOM-kills first)
> → eviction frees *requests* in the scheduler's books and taints the node
> → the controller spawns a replacement
> → the scheduler — blind to usage — bin-packs it onto the most-committed
>   untainted node, typically the next-most-loaded one
> → the replacement regrows toward the same target and tips *that* node
> → repeat.

Amplifiers: taints concentrate refugees onto ever-fewer feasible nodes;
transition-period expiry releases pods back and can set up oscillation;
synchronized CrashLoopBackOff expiries cause regrowth waves. Terminators — the
only ways the loop ends — are states, not code paths: demand shed below
capacity, pods parked Pending, or parameters that keep usage within requests.

## Falsifiability (verified, `src/verify.mjs`, 15 checks)

| Scenario | Parameters | Expected & verified outcome |
|---|---|---|
| A. Overcommitted bin-pack | ratio 3.0×, targets ~75% of limit | cascade active (≥6 kills / ≥3 nodes in 90 s window), kills on ≥4 nodes, evict→reschedule→kill chain links, kubelet evictions **and** kernel OOMs (the race) |
| B. Right-sized limits | ratio 1.0× (Guaranteed) | zero kills, zero kernel OOMs, cascade never forms — usage ≤ requests ≤ allocatable by construction of the *mechanisms*, not a special case |
| C. Raised thresholds | soft 1536 Mi, hard 1024 Mi | kernel OOMs collapse (130 → 11 at seed 42): kubelet gets headroom to act first **and** allocatable shrinks so less is booked; failure mode shifts to orderly early eviction |
| D. Overcommit that fits | ratio 3.0×, targets ~45% | transient churn while eviction rebalances the packing, then quiet (0 kills in ticks 1200–1800) |
| Determinism | seed 42 twice | identical counters |
| Seed robustness | seeds 7, 1337, 20260706 | A cascades, B stays calm on all |

The same checks were re-run through the built page in headless Chromium
(engine + UI + live `setParams`), including extinguishing an active cascade by
dragging the limit ratio to 1.0 mid-run.

## Ground truth vs. model

| Mechanism | In the model | Matches Kubernetes? |
|---|---|---|
| Allocatable | `capacity − reserved − evictionHard` | yes (node allocatable formula) |
| Scheduling | requests-only fit vs allocatable; MostAllocated / LeastAllocated scoring; taint filter | yes, reduced to NodeResourcesFit + taints |
| Eviction signal | `memory.available = capacity − workingSet`, observed every 10 s per node | yes, incl. observation cadence |
| Soft/hard eviction | grace-period-gated soft with capped pod grace; grace-0 hard; one pod per pass; ranking (exceeds-requests → priority → usage−requests) | yes |
| MemoryPressure | condition ⇒ NoSchedule taint, held `pressureTransitionSec` after clear | yes; default shortened 300 s → 60 s for watchability (tunable to 300) |
| QoS & OOM | Guaranteed/Burstable/BestEffort from R vs L; `oom_score_adj` −997 / formula / 1000; score adds usage fraction | yes |
| Container OOM | `memory.max` kill, in-place restart, 10 s·2ⁿ backoff capped 300 s | yes |
| Controller loop | Failed-on-evict → replacement after informer delay; restarts don't reschedule; immutable specs ⇒ rolling replacement | yes |
| Failed pod's requests | freed to the scheduler immediately, memory drains during grace | yes — and it matters for the cascade |

## Simplifications (deliberate, and why they're safe)

- **All pod memory is anonymous; no page cache.** Kubelet's `memory.available`
  already excludes reclaimable `inactive_file`, so the *signal* semantics
  match; what's lost is a reclaim buffer that delays, but does not change, the
  dynamics.
- **PSI is a derived proximity-to-exhaustion proxy**, displayed per node and
  used only to stall allocation under reclaim. Real kubelets don't act on PSI
  either (PSI-driven eviction is still alpha).
- **One container per pod; memory-only.** CPU throttling, pid/disk eviction
  signals, and `minReclaim` (unset by default upstream) are omitted.
- **Kernel OOM kills one victim per pass** (looped within a tick under
  continued exhaustion), and system daemons jitter deterministically ±3%.
- **Scheduler throughput** capped at 10 binds/s with a 5 s unschedulable
  backoff — coarse but order-of-magnitude right.
