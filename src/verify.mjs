/*
 * Headless verification of the simulation's emergent claims.
 * Runs the same engine the page uses (src/engine.js) under four parameter
 * regimes and asserts the cascade appears/disappears purely as a consequence
 * of the state-update rules. Exits non-zero on any failed assertion.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const KSim = require('./engine.js');

function run(params, seed, ticks, lateFrom) {
  const sim = KSim.create(params, seed);
  let cascadeEver = false, maxWindowKills = 0, maxWindowNodes = 0;
  const lateKills = { from: lateFrom != null ? lateFrom : ticks - 300, count: 0 };
  for (let t = 0; t < ticks; t++) {
    sim.tick();
    const c = sim.cascadeInfo(90);
    if (c.active) cascadeEver = true;
    if (c.kills > maxWindowKills) maxWindowKills = c.kills;
    if (c.nodes > maxWindowNodes) maxWindowNodes = c.nodes;
  }
  for (const k of sim.killLog) if (k.tick >= lateKills.from) lateKills.count++;
  const killNodes = new Set(sim.killLog.map(k => k.nodeIdx));
  const last = sim.history[sim.history.length - 1];
  return {
    counters: sim.counters,
    totalKills: sim.counters.evictSoft + sim.counters.evictHard +
      sim.counters.oomKernel + sim.counters.oomContainer,
    cascadeEver, maxWindowKills, maxWindowNodes,
    killNodeCount: killNodes.size,
    chainLinks: sim.chainLinks,
    lateWindowKills: lateKills.count,
    finalPending: last.pending, finalRunning: last.running,
    finalUsage: Math.round(last.usage), finalCommitted: Math.round(last.committed),
  };
}

let failures = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
  if (!ok) failures++;
}

const TICKS = 900; // 15 simulated minutes
const SEED = 42;

console.log('\n=== A: overcommitted default (limit = 3.0x request, targets ~75% of limit) ===');
const A = run({}, SEED, TICKS);
console.log('   ', JSON.stringify(A));
check('cascade window triggers (>=6 kills across >=3 nodes in 90s)', A.cascadeEver,
  `maxWindowKills=${A.maxWindowKills} maxWindowNodes=${A.maxWindowNodes}`);
check('substantial kill volume', A.totalKills >= 30, `totalKills=${A.totalKills}`);
check('kills span most of the cluster', A.killNodeCount >= 4, `killNodes=${A.killNodeCount}`);
check('evict->reschedule->kill chain links observed', A.chainLinks >= 5,
  `chainLinks=${A.chainLinks}`);
check('kubelet/kernel race produces kernel OOMs', A.counters.oomKernel > 0,
  `oomKernel=${A.counters.oomKernel}`);
check('kubelet evictions also occur', A.counters.evictSoft + A.counters.evictHard > 0,
  `soft=${A.counters.evictSoft} hard=${A.counters.evictHard}`);

console.log('\n=== B: same cluster, limits relaxed to requests (ratio 1.0 => Guaranteed) ===');
const B = run({ limitRatio: 1.0 }, SEED, TICKS);
console.log('   ', JSON.stringify(B));
check('cascade never forms', !B.cascadeEver,
  `maxWindowKills=${B.maxWindowKills} maxWindowNodes=${B.maxWindowNodes}`);
check('kills vanish (usage can no longer exceed scheduled requests)', B.totalKills <= 2,
  `totalKills=${B.totalKills}`);
check('no kernel OOMs', B.counters.oomKernel === 0, `oomKernel=${B.counters.oomKernel}`);

console.log('\n=== C: overcommitted, but eviction thresholds raised (soft 1536Mi, hard 1024Mi) ===');
const C = run({ softEvictionMi: 1536, hardEvictionMi: 1024 }, SEED, TICKS);
console.log('   ', JSON.stringify(C));
check('kernel OOMs collapse vs A (kubelet gets headroom to act first)',
  C.counters.oomKernel < Math.max(1, A.counters.oomKernel * 0.5),
  `A.oomKernel=${A.counters.oomKernel} C.oomKernel=${C.counters.oomKernel}`);
check('failure mode shifts (kill mix and volume differ from A)',
  C.totalKills !== A.totalKills, `A=${A.totalKills} C=${C.totalKills}`);

console.log('\n=== D: overcommitted ratio, but demand fits (targets ~45% of limit) ===');
const D = run({ targetMeanFrac: 0.45 }, SEED, 1800, 1200);
console.log('   ', JSON.stringify(D));
check('cluster stabilizes: eviction rebalances, then kills stop (ticks 1200-1800)',
  D.lateWindowKills <= 1, `lateWindowKills=${D.lateWindowKills}`);
check('total churn well below A', D.totalKills < A.totalKills / 3,
  `A=${A.totalKills} D=${D.totalKills}`);

console.log('\n=== determinism: same seed reproduces identical outcomes ===');
const A2 = run({}, SEED, TICKS);
check('counters identical across runs',
  JSON.stringify(A.counters) === JSON.stringify(A2.counters));

console.log('\n=== seed robustness: cascade in A and calm in B across seeds ===');
for (const s of [7, 1337, 20260706]) {
  const a = run({}, s, TICKS);
  const b = run({ limitRatio: 1.0 }, s, TICKS);
  check(`seed ${s}: A cascades, B calm`, a.cascadeEver && b.totalKills <= 2,
    `A.kills=${a.totalKills} A.cascade=${a.cascadeEver} B.kills=${b.totalKills}`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
