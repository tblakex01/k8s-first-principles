/*
 * k8s bin-packing & memory-pressure eviction — simulation engine.
 * Pure state model: no DOM, no wall clock, seeded RNG. One tick = one second.
 * Runs in the browser (window.KSim) and in Node (module.exports) so the same
 * code that drives the page is verified headlessly by verify.mjs.
 */
(function (global) {
'use strict';

// ---------- deterministic RNG ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// stable per-slot trait draw, independent of tick order
function hash01(n, seed) {
  let h = (Math.imul(n, 2654435761) ^ Math.imul(seed, 340573321)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const DEFAULTS = {
  // cluster
  nodeCount: 6,
  nodeCapacityMi: 16384,      // physical RAM per node
  systemReservedMi: 1536,     // --system-reserved + --kube-reserved
  systemUsageMi: 1100,        // actual working set of system daemons
  // workload (one controller-managed slot per replica)
  replicas: 60,
  requestMi: 768,
  limitRatio: 3.0,            // limit = request * ratio; 1.0 => Guaranteed
  bestEffortFrac: 0.10,       // fraction of slots with no requests/limits
  targetMeanFrac: 0.75,       // steady-state working set as fraction of limit
  targetSpreadFrac: 0.20,
  beTargetMinMi: 128,
  beTargetMaxMi: 512,
  growthTauSec: 60,           // exponential approach time constant
  noiseMi: 4,                 // per-tick gaussian jitter (Mi)
  leakProb: 0,                // chance a workload slot has a memory leak
  leakRateMiPerSec: 40,
  // kubelet eviction manager
  softEvictionMi: 512,        // evict when memory.available < soft (after grace)
  softGraceSec: 15,           // --eviction-soft-grace-period
  hardEvictionMi: 192,        // evict immediately when memory.available < hard
  housekeepingSec: 10,        // kubelet eviction monitoring interval
  pressureTransitionSec: 60,  // --eviction-pressure-transition-period (real default 300)
  maxPodGraceSec: 15,         // --eviction-max-pod-grace-period (soft only)
  // control plane
  controllerDelaySec: 3,      // watch/informer latency before replacement pod exists
  schedulerBindsPerTick: 10,
  unschedulableRetrySec: 5,
  scoreStrategy: 'MostAllocated', // bin-pack; or 'LeastAllocated' (spread)
  maxPodsPerNode: 110,
  rollingMaxUnavailable: 2,   // rolling replacement rate on spec change
};

// params that are part of the pod spec: changing them triggers a rolling
// replacement (pods are immutable in Kubernetes; a Deployment rolls instead)
const SPEC_PARAMS = ['requestMi', 'limitRatio', 'bestEffortFrac',
  'targetMeanFrac', 'targetSpreadFrac', 'beTargetMinMi', 'beTargetMaxMi',
  'leakProb'];

function create(paramsIn, seed) {
  const params = Object.assign({}, DEFAULTS, paramsIn || {});
  seed = (seed == null ? 42 : seed) >>> 0;
  const rng = mulberry32(seed);
  let gaussSpare = null;
  function gauss() {
    if (gaussSpare !== null) { const g = gaussSpare; gaussSpare = null; return g; }
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    const m = Math.sqrt(-2 * Math.log(u));
    gaussSpare = m * Math.sin(2 * Math.PI * v);
    return m * Math.cos(2 * Math.PI * v);
  }

  const sim = {
    params, seed, tickNo: 0, specVersion: 0,
    nodes: [], pods: [], podById: new Map(), nextPodId: 1,
    pendingSpawns: [],          // {atTick, slot, gen}
    leakForced: new Set(),      // slots forced leaky via injectLeak()
    counters: { evictSoft: 0, evictHard: 0, oomKernel: 0, oomContainer: 0,
                restarts: 0, reschedules: 0, created: 0, rolled: 0,
                unschedInsufficient: 0, unschedPressure: 0 },
    killLog: [],                // {tick, nodeIdx, type, pod}
    landings: [],               // {tick, nodeIdx} replacement (gen>0) binds
    chainLinks: 0,              // kills on a node soon after a replacement landed there
    events: [],                 // rolling human-readable log
    lastTickEvents: [],
    history: [],                // per-tick metrics ring
    historyCap: 1800,
  };

  // ---------- node helpers ----------
  function allocatableMi() {
    // ground truth: Allocatable = Capacity - Reserved - EvictionHard
    return Math.max(0,
      params.nodeCapacityMi - params.systemReservedMi - params.hardEvictionMi);
  }
  function makeNode(idx) {
    return {
      idx, name: 'node-' + (idx + 1),
      committedMi: 0,           // sum of bound pod requests (scheduler view)
      podIds: new Set(),
      workingSetMi: 0, memAvailableMi: params.nodeCapacityMi,
      psiSome: 0, psiFull: 0,
      pressure: false,          // MemoryPressure condition (=> NoSchedule taint)
      softSinceTick: -1,        // first housekeeping observation below soft
      lastExceededTick: -1,
    };
  }
  function systemUsage(node) {
    // deterministic daemon jitter (~±3%)
    return params.systemUsageMi *
      (1 + 0.03 * Math.sin((sim.tickNo + node.idx * 7) / 29));
  }
  function nodeWorkingSet(node) {
    let ws = systemUsage(node);
    for (const id of node.podIds) {
      const p = sim.podById.get(id);
      if (p) ws += p.usageMi;
    }
    return ws;
  }
  function refreshNodeSignals(node) {
    node.workingSetMi = nodeWorkingSet(node);
    // kubelet signal: memory.available = capacity - workingSet(root cgroup).
    // Simplification: pod memory is all anonymous (page cache treated as
    // already-reclaimed inactive_file, which kubelet excludes anyway).
    node.memAvailableMi = params.nodeCapacityMi - node.workingSetMi;
    // PSI proxy: reclaim stall rises as free memory approaches zero
    const band = 0.06 * params.nodeCapacityMi;
    node.psiSome = clamp(1 - node.memAvailableMi / band, 0, 1);
    node.psiFull = node.psiSome * node.psiSome;
  }

  // ---------- pod spec (per workload slot) ----------
  function slotIsBE(slot) { return hash01(slot * 3 + 1, seed) < params.bestEffortFrac; }
  function slotLeaky(slot) {
    return sim.leakForced.has(slot) || hash01(slot * 3 + 2, seed) < params.leakProb;
  }
  function makePod(slot, gen) {
    const isBE = slotIsBE(slot);
    const requestMi = isBE ? 0 : params.requestMi;
    const limitMi = isBE ? 0 : Math.round(params.requestMi * params.limitRatio);
    const qos = isBE ? 'BestEffort'
      : (limitMi === requestMi ? 'Guaranteed' : 'Burstable');
    let targetMi;
    if (isBE) {
      targetMi = params.beTargetMinMi + hash01(slot * 7 + gen * 13 + 3, seed) *
        (params.beTargetMaxMi - params.beTargetMinMi);
    } else {
      const frac = clamp(
        params.targetMeanFrac +
          (hash01(slot * 7 + gen * 13 + 3, seed) * 2 - 1) * params.targetSpreadFrac,
        0.05, 0.92);
      targetMi = limitMi * frac;
    }
    const pod = {
      id: sim.nextPodId++, slot, gen,
      name: 'app-' + slot + '-' + gen,
      qos, requestMi, limitMi, targetMi,
      leaky: slotLeaky(slot),
      priority: 0,
      state: 'pending',         // pending|running|backoff|terminating|gone
      nodeIdx: -1,
      usageMi: 0, baseMi: 24 + rng() * 48,
      createdTick: sim.tickNo, boundTick: -1,
      retryAtTick: 0,
      termEndsTick: -1, termRate: 0,
      restarts: 0, backoffUntilTick: -1,
      specVersion: sim.specVersion,
      unschedReason: null,
    };
    sim.pods.push(pod);
    sim.podById.set(pod.id, pod);
    sim.counters.created++;
    return pod;
  }
  function removePod(pod) {
    if (pod.nodeIdx >= 0) {
      const node = sim.nodes[pod.nodeIdx];
      if (node) node.podIds.delete(pod.id);
    }
    pod.state = 'gone';
    pod.nodeIdx = -1;
    pod.usageMi = 0;
  }
  function spawnReplacement(slot, gen) {
    sim.pendingSpawns.push({ atTick: sim.tickNo + params.controllerDelaySec, slot, gen });
  }

  function logEvent(type, detail, nodeIdx, podName) {
    const ev = { tick: sim.tickNo, type, detail, nodeIdx, podName };
    sim.events.push(ev);
    if (sim.events.length > 500) sim.events.splice(0, sim.events.length - 500);
    sim.lastTickEvents.push(ev);
  }
  function logKill(type, node, pod) {
    sim.killLog.push({ tick: sim.tickNo, nodeIdx: node.idx, type, pod: pod.name });
    if (sim.killLog.length > 20000) sim.killLog.splice(0, 5000);
    // cascade chain witness: did a rescheduled pod land here recently?
    for (let i = sim.landings.length - 1; i >= 0; i--) {
      const l = sim.landings[i];
      if (sim.tickNo - l.tick > 60) break;
      if (l.nodeIdx === node.idx) { sim.chainLinks++; break; }
    }
  }

  // ---------- kill paths ----------
  function containerKill(pod, type) {
    // cgroup/kernel OOM kills the container process; the pod object stays on
    // the node and restarts in place under CrashLoopBackOff.
    pod.restarts++;
    sim.counters.restarts++;
    pod.usageMi = 0;
    pod.state = 'backoff';
    const backoff = Math.min(10 * Math.pow(2, Math.min(pod.restarts - 1, 5)), 300);
    pod.backoffUntilTick = sim.tickNo + backoff;
    const node = sim.nodes[pod.nodeIdx];
    if (type === 'oomKernel') sim.counters.oomKernel++;
    else sim.counters.oomContainer++;
    logKill(type, node, pod);
    logEvent(type, 'backoff ' + backoff + 's', node.idx, pod.name);
  }
  function oomScoreAdj(pod) {
    // ground-truth kubelet values
    if (pod.qos === 'Guaranteed') return -997;
    if (pod.qos === 'BestEffort') return 1000;
    return clamp(Math.round(1000 - 1000 * pod.requestMi / params.nodeCapacityMi), 2, 999);
  }
  function kernelOOM(node) {
    // kernel acts every tick, unlike the 10s kubelet loop — this race is real
    let guard = 0;
    refreshNodeSignals(node);
    while (node.memAvailableMi <= 0 && guard++ < 8) {
      let victim = null, best = -Infinity;
      for (const id of node.podIds) {
        const p = sim.podById.get(id);
        if (!p || p.state !== 'running' || p.usageMi <= 0) continue;
        const score = Math.round(1000 * p.usageMi / params.nodeCapacityMi) + oomScoreAdj(p);
        if (score > best) { best = score; victim = p; }
      }
      if (!victim) break;
      containerKill(victim, 'oomKernel');
      refreshNodeSignals(node);
    }
  }

  // kubelet eviction ranking for memory (ground truth):
  // 1) pods whose usage exceeds requests first, 2) lower priority first,
  // 3) larger usage-over-request first.
  function evictionRank(a, b) {
    const ea = a.usageMi > a.requestMi ? 0 : 1;
    const eb = b.usageMi > b.requestMi ? 0 : 1;
    if (ea !== eb) return ea - eb;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return (b.usageMi - b.requestMi) - (a.usageMi - a.requestMi);
  }
  function evictOne(node, graceSec, kind) {
    const cands = [];
    for (const id of node.podIds) {
      const p = sim.podById.get(id);
      if (p && (p.state === 'running' || p.state === 'backoff')) cands.push(p);
    }
    if (!cands.length) return false;
    cands.sort(evictionRank);
    const victim = cands[0];
    // pod phase -> Failed immediately: the controller reacts now, and the
    // scheduler stops counting its requests, even while memory drains.
    node.committedMi -= victim.requestMi;
    if (kind === 'hard') sim.counters.evictHard++; else sim.counters.evictSoft++;
    logKill(kind === 'hard' ? 'evictHard' : 'evictSoft', node, victim);
    logEvent(kind === 'hard' ? 'evictHard' : 'evictSoft',
      'memory.available ' + Math.round(node.memAvailableMi) + 'Mi', node.idx, victim.name);
    if (graceSec <= 0) {
      removePod(victim);
    } else {
      victim.state = 'terminating';
      victim.termEndsTick = sim.tickNo + graceSec;
      victim.termRate = victim.usageMi / graceSec;
    }
    spawnReplacement(victim.slot, victim.gen + 1);
    return true;
  }

  function housekeeping(node) {
    refreshNodeSignals(node);
    const avail = node.memAvailableMi;
    const underSoft = avail < params.softEvictionMi;
    const underHard = avail < params.hardEvictionMi;

    if (underSoft) {
      if (node.softSinceTick < 0) node.softSinceTick = sim.tickNo;
    } else {
      node.softSinceTick = -1;
    }

    if (underSoft || underHard) {
      node.lastExceededTick = sim.tickNo;
      if (!node.pressure) {
        node.pressure = true;
        logEvent('pressureOn', 'memory.available ' + Math.round(avail) + 'Mi', node.idx);
      }
    } else if (node.pressure &&
        sim.tickNo - node.lastExceededTick >= params.pressureTransitionSec) {
      // eviction-pressure-transition-period keeps the condition (and taint)
      // up after the signal clears, damping schedule/evict flapping
      node.pressure = false;
      logEvent('pressureOff', '', node.idx);
    }

    if (underHard) {
      evictOne(node, 0, 'hard');   // hard eviction: no grace
    } else if (underSoft && node.softSinceTick >= 0 &&
        sim.tickNo - node.softSinceTick >= params.softGraceSec) {
      evictOne(node, Math.max(1, params.maxPodGraceSec), 'soft');
    }
  }

  // ---------- scheduler ----------
  function feasible(node, pod) {
    if (node.pressure) return false;   // node.kubernetes.io/memory-pressure taint
    if (node.podIds.size >= params.maxPodsPerNode) return false;
    // requests-only fit against Allocatable: the scheduler never sees usage
    return node.committedMi + pod.requestMi <= allocatableMi();
  }
  function schedule() {
    const queue = sim.pods.filter(p =>
      p.state === 'pending' && p.retryAtTick <= sim.tickNo);
    queue.sort((a, b) => a.createdTick - b.createdTick || a.id - b.id);
    let binds = 0;
    for (const pod of queue) {
      if (binds >= params.schedulerBindsPerTick) break;
      const fits = sim.nodes.filter(n => feasible(n, pod));
      if (!fits.length) {
        pod.retryAtTick = sim.tickNo + params.unschedulableRetrySec;
        const anyCapacity = sim.nodes.some(n =>
          n.podIds.size < params.maxPodsPerNode &&
          n.committedMi + pod.requestMi <= allocatableMi());
        pod.unschedReason = anyCapacity ? 'pressure-taint' : 'insufficient-memory';
        if (anyCapacity) sim.counters.unschedPressure++;
        else sim.counters.unschedInsufficient++;
        continue;
      }
      let best = null, bestScore = -Infinity;
      for (const n of fits) {
        const util = (n.committedMi + pod.requestMi) / Math.max(1, allocatableMi());
        let score = params.scoreStrategy === 'MostAllocated' ? util : 1 - util;
        score += rng() * 1e-6; // stable-ish tie break
        if (score > bestScore) { bestScore = score; best = n; }
      }
      pod.state = 'running';
      pod.nodeIdx = best.idx;
      pod.boundTick = sim.tickNo;
      pod.usageMi = pod.baseMi;
      pod.unschedReason = null;
      best.podIds.add(pod.id);
      best.committedMi += pod.requestMi;
      binds++;
      if (pod.gen > 0) {
        sim.counters.reschedules++;
        sim.landings.push({ tick: sim.tickNo, nodeIdx: best.idx });
        if (sim.landings.length > 4000) sim.landings.splice(0, 1000);
      }
      logEvent('scheduled', pod.gen > 0 ? 'rescheduled (gen ' + pod.gen + ')' : 'initial',
        best.idx, pod.name);
    }
  }

  // ---------- controller (Deployment-ish reconcile) ----------
  function controller() {
    // 1) due replacement spawns
    for (let i = sim.pendingSpawns.length - 1; i >= 0; i--) {
      const s = sim.pendingSpawns[i];
      if (s.atTick <= sim.tickNo) {
        if (s.slot < params.replicas) makePod(s.slot, s.gen);
        sim.pendingSpawns.splice(i, 1);
      }
    }
    // 2) reconcile desired replica slots
    const live = new Map(); // slot -> pod (non-gone) or spawn marker
    for (const p of sim.pods) {
      if (p.state !== 'gone' && p.state !== 'terminating') live.set(p.slot, p);
    }
    for (const s of sim.pendingSpawns) live.set(s.slot, true);
    for (let slot = 0; slot < params.replicas; slot++) {
      if (!live.has(slot)) makePod(slot, 0);
    }
    for (const p of sim.pods) {
      if (p.slot >= params.replicas &&
          (p.state === 'running' || p.state === 'backoff' || p.state === 'pending')) {
        if (p.state === 'pending') { removePod(p); continue; }
        const node = sim.nodes[p.nodeIdx];
        if (node) node.committedMi -= p.requestMi;
        removePod(p);
      }
    }
    // 3) rolling replacement of stale-spec pods (pods are immutable; a spec
    // change rolls the workload at a bounded rate)
    let rolled = 0;
    for (const p of sim.pods) {
      if (rolled >= params.rollingMaxUnavailable) break;
      if (p.specVersion === sim.specVersion) continue;
      if (p.state === 'pending') { // cheap: replace queued pod spec in place
        removePod(p); spawnReplacement(p.slot, p.gen + 1); continue;
      }
      if (p.state !== 'running' && p.state !== 'backoff') continue;
      const node = sim.nodes[p.nodeIdx];
      if (node) node.committedMi -= p.requestMi;
      p.state = 'terminating';
      p.termEndsTick = sim.tickNo + 5;
      p.termRate = p.usageMi / 5;
      spawnReplacement(p.slot, p.gen + 1);
      sim.counters.rolled++;
      rolled++;
    }
  }

  // ---------- pod dynamics ----------
  function growPods() {
    for (const p of sim.pods) {
      if (p.state === 'backoff') {
        if (sim.tickNo >= p.backoffUntilTick) {
          p.state = 'running';
          p.usageMi = p.baseMi;
          logEvent('restart', 'restart #' + p.restarts, p.nodeIdx, p.name);
        }
        continue;
      }
      if (p.state === 'terminating') {
        p.usageMi = Math.max(0, p.usageMi - p.termRate);
        if (sim.tickNo >= p.termEndsTick) removePod(p);
        continue;
      }
      if (p.state !== 'running') continue;
      const node = sim.nodes[p.nodeIdx];
      const throttle = node ? 1 - 0.6 * node.psiFull : 1; // reclaim stall slows allocation
      const drive = (p.targetMi - p.usageMi) / params.growthTauSec;
      p.usageMi += drive * throttle + gauss() * params.noiseMi;
      if (p.leaky) p.usageMi += params.leakRateMiPerSec * throttle;
      p.usageMi = Math.max(8, p.usageMi);
    }
  }
  function containerLimitOOM() {
    // cgroup v2 memory.max on the pod cgroup (kubelet sets it to the limit)
    for (const p of sim.pods) {
      if (p.state === 'running' && p.limitMi > 0 && p.usageMi >= p.limitMi) {
        containerKill(p, 'oomContainer');
      }
    }
  }

  // ---------- structure changes ----------
  function reconcileNodes() {
    while (sim.nodes.length < params.nodeCount) {
      sim.nodes.push(makeNode(sim.nodes.length));
    }
    while (sim.nodes.length > params.nodeCount) {
      const node = sim.nodes.pop();
      for (const id of Array.from(node.podIds)) {
        const p = sim.podById.get(id);
        if (!p) continue;
        logEvent('drained', 'node removed', node.idx, p.name);
        removePod(p);
        if (p.slot < params.replicas) spawnReplacement(p.slot, p.gen + 1);
      }
    }
  }

  // ---------- public API ----------
  sim.setParams = function (patch) {
    let specChanged = false;
    for (const k of Object.keys(patch)) {
      if (params[k] === patch[k]) continue;
      params[k] = patch[k];
      if (SPEC_PARAMS.indexOf(k) >= 0) specChanged = true;
    }
    if (specChanged) sim.specVersion++;
    reconcileNodes();
  };
  sim.injectLeak = function () {
    const running = sim.pods.filter(p => p.state === 'running' && p.qos !== 'BestEffort');
    if (!running.length) return null;
    const p = running[Math.floor(rng() * running.length)];
    sim.leakForced.add(p.slot);
    p.leaky = true;
    logEvent('leakInjected', 'workload slot ' + p.slot + ' now leaks', p.nodeIdx, p.name);
    return p.name;
  };
  sim.allocatableMi = allocatableMi;
  sim.cascadeInfo = function (windowTicks) {
    const w = windowTicks || 90;
    const nodes = new Set();
    let kills = 0;
    for (let i = sim.killLog.length - 1; i >= 0; i--) {
      const k = sim.killLog[i];
      if (sim.tickNo - k.tick > w) break;
      kills++; nodes.add(k.nodeIdx);
    }
    return { kills, nodes: nodes.size, active: kills >= 6 && nodes.size >= 3,
             chainLinks: sim.chainLinks };
  };

  sim.tick = function () {
    sim.tickNo++;
    sim.lastTickEvents = [];
    growPods();
    containerLimitOOM();
    for (const node of sim.nodes) {
      refreshNodeSignals(node);
      kernelOOM(node);                       // kernel: every tick
      if ((sim.tickNo + node.idx) % params.housekeepingSec === 0) {
        housekeeping(node);                  // kubelet: every housekeepingSec
      }
    }
    controller();
    schedule();
    for (const node of sim.nodes) refreshNodeSignals(node);
    // prune gone pods occasionally
    if (sim.tickNo % 30 === 0) {
      const keep = [];
      for (const p of sim.pods) {
        if (p.state === 'gone') sim.podById.delete(p.id);
        else keep.push(p);
      }
      sim.pods = keep;
    }
    // metrics
    let usage = 0, committed = 0, running = 0, pending = 0, backoff = 0;
    for (const p of sim.pods) {
      if (p.state === 'running' || p.state === 'terminating') usage += p.usageMi;
      if (p.state === 'running') running++;
      else if (p.state === 'pending') pending++;
      else if (p.state === 'backoff') backoff++;
    }
    for (const n of sim.nodes) { usage += systemUsage(n); committed += n.committedMi; }
    const kt = { es: 0, eh: 0, ok: 0, oc: 0 };
    for (const e of sim.lastTickEvents) {
      if (e.type === 'evictSoft') kt.es++;
      else if (e.type === 'evictHard') kt.eh++;
      else if (e.type === 'oomKernel') kt.ok++;
      else if (e.type === 'oomContainer') kt.oc++;
    }
    sim.history.push({
      tick: sim.tickNo, usage, committed,
      capacity: params.nodeCapacityMi * sim.nodes.length,
      allocatable: allocatableMi() * sim.nodes.length,
      running, pending, backoff, kills: kt,
      pressureNodes: sim.nodes.filter(n => n.pressure).length,
    });
    if (sim.history.length > sim.historyCap) sim.history.splice(0, 200);
  };

  // ---------- init ----------
  reconcileNodes();
  for (let slot = 0; slot < params.replicas; slot++) makePod(slot, 0);

  return sim;
}

const KSim = { create, DEFAULTS, mulberry32, hash01 };
if (typeof module !== 'undefined' && module.exports) module.exports = KSim;
else global.KSim = KSim;
})(typeof window !== 'undefined' ? window : globalThis);
