(function () {
'use strict';
/* UI layer: renders engine state and routes live parameter changes.
 * All dynamics live in the engine; this file only draws and wires inputs. */

const $ = (id) => document.getElementById(id);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// ---------- sim lifecycle ----------
let seed = 42;
let uiParams = Object.assign({}, KSim.DEFAULTS);
let sim = KSim.create(uiParams, seed);
let running = true;
let speed = 5;
let acc = 0, lastFrame = performance.now(), lastRender = 0;
let uiEvents = [];               // events accumulated since last render
const flashUntil = new Map();    // nodeIdx -> ms timestamp
const lastEvictNodeBySlot = new Map();
let arcs = [];                   // {from,to,born}

function resetSim(bumpSeed) {
  if (bumpSeed) seed = (seed + 1) >>> 0;
  sim = KSim.create(uiParams, seed);
  uiEvents = []; arcs = []; flashUntil.clear(); lastEvictNodeBySlot.clear();
  acc = 0;
}

function doTicks(n) {
  for (let i = 0; i < n; i++) {
    sim.tick();
    for (const e of sim.lastTickEvents) uiEvents.push(e);
  }
  if (uiEvents.length > 400) uiEvents.splice(0, uiEvents.length - 400);
}

// ---------- controls ----------
const fmtMi = (v) => v >= 1024 ? (v / 1024).toFixed(v % 1024 ? 1 : 0) + 'Gi' : Math.round(v) + 'Mi';
const fmtS = (v) => v + 's';
const fmtPct = (v) => Math.round(v * 100) + '%';
const CONTROLS = [
  { group: 'Cluster', items: [
    { k: 'nodeCount', label: 'Nodes', min: 2, max: 12, step: 1, fmt: String },
    { k: 'nodeCapacityMi', label: 'Node RAM (capacity)', min: 8192, max: 32768, step: 1024, fmt: fmtMi },
    { k: 'systemReservedMi', label: 'Reserved (system+kube)', min: 512, max: 4096, step: 128, fmt: fmtMi },
  ]},
  { group: 'Workload', items: [
    { k: 'replicas', label: 'Replicas', min: 10, max: 150, step: 1, fmt: String },
    { k: 'requestMi', label: 'Memory request', min: 128, max: 4096, step: 64, fmt: fmtMi },
    { k: 'limitRatio', label: 'Limit : request', min: 1, max: 4, step: 0.05, fmt: (v) => v.toFixed(2) + '×' },
    { k: 'targetMeanFrac', label: 'Mean working set (of limit)', min: 0.2, max: 0.9, step: 0.01, fmt: fmtPct },
    { k: 'bestEffortFrac', label: 'BestEffort share', min: 0, max: 0.3, step: 0.01, fmt: fmtPct },
    { k: 'growthTauSec', label: 'Growth time constant', min: 15, max: 180, step: 5, fmt: fmtS },
    { k: 'leakRateMiPerSec', label: 'Leak rate', min: 10, max: 150, step: 5, fmt: (v) => v + 'Mi/s' },
  ]},
  { group: 'Kubelet eviction', items: [
    { k: 'softEvictionMi', label: 'Soft: memory.available <', min: 256, max: 2048, step: 32, fmt: fmtMi },
    { k: 'softGraceSec', label: 'Soft grace period', min: 0, max: 60, step: 1, fmt: fmtS },
    { k: 'hardEvictionMi', label: 'Hard: memory.available <', min: 64, max: 1280, step: 32, fmt: fmtMi },
    { k: 'housekeepingSec', label: 'Housekeeping interval', min: 2, max: 30, step: 1, fmt: fmtS },
    { k: 'pressureTransitionSec', label: 'Pressure transition period', min: 10, max: 300, step: 5, fmt: fmtS },
    { k: 'maxPodGraceSec', label: 'Max pod grace (soft)', min: 1, max: 60, step: 1, fmt: fmtS },
  ]},
];
const ctlEls = new Map();

function buildControls() {
  const panel = $('ctlPanel');
  for (const g of CONTROLS) {
    const h = document.createElement('h3');
    h.className = 'panel-title'; h.textContent = g.group;
    panel.appendChild(h);
    const wrap = document.createElement('div');
    wrap.className = 'ctl-group'; wrap.style.marginBottom = '14px';
    for (const c of g.items) {
      const div = document.createElement('div'); div.className = 'ctl';
      const row = document.createElement('div'); row.className = 'ctl-row';
      const label = document.createElement('label');
      label.textContent = c.label; label.htmlFor = 'ctl-' + c.k;
      const out = document.createElement('output');
      out.textContent = c.fmt(uiParams[c.k]);
      row.appendChild(label); row.appendChild(out);
      const input = document.createElement('input');
      input.type = 'range'; input.id = 'ctl-' + c.k;
      input.min = c.min; input.max = c.max; input.step = c.step;
      input.value = uiParams[c.k];
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        uiParams[c.k] = v;
        out.textContent = c.fmt(v);
        sim.setParams({ [c.k]: v });
      });
      div.appendChild(row); div.appendChild(input);
      wrap.appendChild(div);
      ctlEls.set(c.k, { input, out, fmt: c.fmt });
    }
    panel.appendChild(wrap);
  }
  // scheduler strategy
  const h = document.createElement('h3');
  h.className = 'panel-title'; h.textContent = 'Scheduler';
  panel.appendChild(h);
  const sel = document.createElement('select');
  sel.setAttribute('aria-label', 'Scheduler scoring strategy');
  sel.style.width = '100%';
  for (const [v, t] of [['MostAllocated', 'MostAllocated — bin-pack'],
                        ['LeastAllocated', 'LeastAllocated — spread']]) {
    const o = document.createElement('option'); o.value = v; o.textContent = t;
    sel.appendChild(o);
  }
  sel.value = uiParams.scoreStrategy;
  sel.addEventListener('change', () => {
    uiParams.scoreStrategy = sel.value;
    sim.setParams({ scoreStrategy: sel.value });
  });
  panel.appendChild(sel);
  ctlEls.set('scoreStrategy', { input: sel, out: null, fmt: String });
}

function syncControls() {
  for (const [k, el] of ctlEls) {
    el.input.value = uiParams[k];
    if (el.out) el.out.textContent = el.fmt(uiParams[k]);
  }
}

const PRESETS = [
  { name: 'Overcommitted bin-pack', desc: 'limit 3× request, working sets ~75% of limit — a cascade forms',
    patch: { limitRatio: 3.0, targetMeanFrac: 0.75, softEvictionMi: 512, hardEvictionMi: 192, scoreStrategy: 'MostAllocated' } },
  { name: 'Right-sized limits', desc: 'limit = request (Guaranteed) — the cascade cannot form',
    patch: { limitRatio: 1.0 } },
  { name: 'Early-eviction headroom', desc: 'soft 1536Mi / hard 1024Mi — kubelet beats the kernel OOM killer',
    patch: { softEvictionMi: 1536, hardEvictionMi: 1024 } },
  { name: 'Overcommit that fits', desc: 'same 3× ratio, working sets ~45% — transient churn, then quiet',
    patch: { limitRatio: 3.0, targetMeanFrac: 0.45 } },
];
function buildPresets() {
  const row = $('presets');
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.innerHTML = p.name + '<span></span>';
    b.querySelector('span').textContent = p.desc;
    b.addEventListener('click', () => {
      Object.assign(uiParams, p.patch);
      sim.setParams(p.patch);
      syncControls();
    });
    row.appendChild(b);
  }
}

// ---------- stat tiles ----------
const TILES = [
  { k: 'running', label: 'Running', dot: 'var(--qos-b)' },
  { k: 'pending', label: 'Pending', dot: 'var(--accent)' },
  { k: 'evict', label: 'Evictions', dot: 'var(--st-serious)' },
  { k: 'oomk', label: 'Kernel OOM', dot: 'var(--st-crit)' },
  { k: 'oomc', label: 'Container OOM', dot: 'var(--st-warn)' },
  { k: 'resched', label: 'Reschedules', dot: 'var(--qos-g)' },
];
const tileEls = {};
function buildTiles() {
  const wrap = $('tiles');
  for (const t of TILES) {
    const d = document.createElement('div'); d.className = 'tile';
    d.innerHTML = '<div class="t-label"><i class="dot"></i>' + t.label +
      '</div><div class="t-value">0</div><div class="t-sub"></div>';
    d.querySelector('.dot').style.background = t.dot;
    wrap.appendChild(d);
    tileEls[t.k] = { value: d.querySelector('.t-value'), sub: d.querySelector('.t-sub') };
  }
}
function renderTiles() {
  const h = sim.history[sim.history.length - 1];
  if (!h) return;
  const c = sim.counters;
  tileEls.running.value.textContent = h.running;
  tileEls.running.sub.textContent = h.backoff ? h.backoff + ' in backoff' : '';
  tileEls.pending.value.textContent = h.pending;
  tileEls.pending.sub.textContent = h.pressureNodes ? h.pressureNodes + ' node(s) tainted' : '';
  tileEls.evict.value.textContent = c.evictSoft + c.evictHard;
  tileEls.evict.sub.textContent = 'soft ' + c.evictSoft + ' · hard ' + c.evictHard;
  tileEls.oomk.value.textContent = c.oomKernel;
  tileEls.oomk.sub.textContent = c.oomKernel ? 'kernel raced 10s kubelet loop' : '';
  tileEls.oomc.value.textContent = c.oomContainer;
  tileEls.oomc.sub.textContent = 'cgroup memory.max · ' + c.restarts + ' restarts';
  tileEls.resched.value.textContent = c.reschedules;
  tileEls.resched.sub.textContent = sim.chainLinks + ' cascade links';
  const ci = sim.cascadeInfo(90);
  const chip = $('cascadeChip');
  chip.textContent = ci.active
    ? 'CASCADE · ' + ci.kills + ' kills / ' + ci.nodes + ' nodes (90s)'
    : 'cascade: quiet' + (ci.kills ? ' · ' + ci.kills + ' kills (90s)' : '');
  chip.classList.toggle('active', ci.active);
  const t = sim.tickNo;
  $('clock').textContent = 't=' + Math.floor(t / 60) + 'm' + String(t % 60).padStart(2, '0') + 's';
}

// ---------- nodes ----------
const BAR_H = 236;
function renderNodes() {
  const wrap = $('nodes');
  const cap = sim.params.nodeCapacityMi;
  const alloc = sim.allocatableMi();
  const now = performance.now();
  const frag = document.createDocumentFragment();
  for (const node of sim.nodes) {
    const card = document.createElement('div');
    card.className = 'node' + ((flashUntil.get(node.idx) || 0) > now ? ' flash' : '');
    card.dataset.idx = node.idx;

    const pods = [];
    for (const id of node.podIds) {
      const p = sim.podById.get(id);
      if (p) pods.push(p);
    }
    pods.sort((a, b) => a.boundTick - b.boundTick || a.id - b.id);

    const avail = Math.round(node.memAvailableMi);
    const head = document.createElement('div'); head.className = 'node-head';
    head.innerHTML = '<span class="node-name"></span><span class="chip"></span>';
    head.querySelector('.node-name').textContent = node.name;
    const chip = head.querySelector('.chip');
    if (node.pressure) { chip.className = 'chip pressure'; chip.textContent = 'Pressure'; }
    else { chip.className = 'chip ready'; chip.textContent = 'Ready'; }
    card.appendChild(head);

    const availEl = document.createElement('div');
    availEl.className = 'node-avail mono';
    availEl.innerHTML = 'avail <b></b> · ws ';
    availEl.querySelector('b').textContent = fmtMi(Math.max(0, avail));
    availEl.append(fmtMi(Math.round(node.workingSetMi)));
    card.appendChild(availEl);

    const bars = document.createElement('div'); bars.className = 'node-bars';
    // kernel view: stacked working sets
    const ubar = document.createElement('div'); ubar.className = 'bar usage';
    const sysMi = node.workingSetMi - pods.reduce((s, p) => s + p.usageMi, 0);
    let cum = 0;
    const sys = document.createElement('div');
    sys.className = 'seg sys';
    sys.style.bottom = '0px';
    sys.style.height = Math.max(1, sysMi / cap * BAR_H) + 'px';
    ubar.appendChild(sys);
    cum += sysMi;
    let sliver = 0;
    for (const p of pods) {
      const seg = document.createElement('div');
      const qcls = p.qos === 'Guaranteed' ? 'qg' : p.qos === 'Burstable' ? 'qb' : 'qbe';
      seg.className = 'seg ' + qcls +
        (p.leaky ? ' leaky' : '') +
        (p.state === 'terminating' ? ' terminating' : '') +
        (p.state === 'backoff' ? ' backoff' : '');
      seg.dataset.pid = p.id;
      if (p.state === 'backoff') {
        seg.style.bottom = Math.min(BAR_H - 6, cum / cap * BAR_H + sliver) + 'px';
        sliver += 7;
      } else {
        const h = Math.max(1, p.usageMi / cap * BAR_H - 2);
        seg.style.bottom = (cum / cap * BAR_H + 1) + 'px';
        seg.style.height = h + 'px';
        cum += p.usageMi;
      }
      ubar.appendChild(seg);
    }
    for (const [cls, mi] of [['soft', sim.params.softEvictionMi], ['hard', sim.params.hardEvictionMi]]) {
      const l = document.createElement('div');
      l.className = 'thline ' + cls;
      l.style.bottom = ((cap - mi) / cap * BAR_H) + 'px';
      ubar.appendChild(l);
    }
    bars.appendChild(ubar);
    // scheduler view: committed requests vs allocatable
    const rbar = document.createElement('div'); rbar.className = 'bar req';
    const rfill = document.createElement('div'); rfill.className = 'req-fill';
    rfill.style.height = Math.max(0, Math.min(1, node.committedMi / cap)) * BAR_H + 'px';
    rbar.appendChild(rfill);
    const al = document.createElement('div');
    al.className = 'thline alloc';
    al.style.bottom = (alloc / cap * BAR_H) + 'px';
    rbar.appendChild(al);
    bars.appendChild(rbar);
    card.appendChild(bars);

    const labels = document.createElement('div');
    labels.className = 'bar-labels';
    labels.innerHTML = '<span class="u">usage</span><span>req</span>';
    card.appendChild(labels);

    const foot = document.createElement('div'); foot.className = 'node-foot';
    const pn = document.createElement('span'); pn.className = 'pods-n';
    pn.textContent = pods.length + ' pods';
    const psi = document.createElement('div'); psi.className = 'psi';
    psi.title = 'PSI (reclaim stall proxy)';
    const pi = document.createElement('i');
    pi.style.width = Math.round(node.psiSome * 100) + '%';
    pi.style.background = node.psiSome > 0.66 ? 'var(--st-crit)'
      : node.psiSome > 0.33 ? 'var(--st-warn)' : 'var(--st-good)';
    psi.appendChild(pi);
    foot.appendChild(pn); foot.appendChild(psi);
    card.appendChild(foot);
    frag.appendChild(card);
  }
  wrap.replaceChildren(frag);
}

// pod tooltip (delegated)
const podTip = $('podTip');
document.addEventListener('mousemove', (e) => {
  const seg = e.target.closest && e.target.closest('.seg[data-pid]');
  if (!seg) { podTip.style.display = 'none'; return; }
  const p = sim.podById.get(+seg.dataset.pid);
  if (!p) { podTip.style.display = 'none'; return; }
  podTip.innerHTML = '<b></b><br>';
  podTip.querySelector('b').textContent = p.name + ' · ' + p.qos + (p.leaky ? ' · LEAKING' : '');
  podTip.append(
    'usage ' + Math.round(p.usageMi) + 'Mi / req ' + p.requestMi + 'Mi / lim ' +
    (p.limitMi || '∞') + 'Mi');
  const l2 = document.createElement('div');
  l2.textContent = 'target ' + Math.round(p.targetMi) + 'Mi · restarts ' + p.restarts +
    ' · ' + p.state + ' · gen ' + p.gen;
  podTip.appendChild(l2);
  podTip.style.display = 'block';
  const x = Math.min(e.clientX + 14, window.innerWidth - podTip.offsetWidth - 8);
  const y = Math.min(e.clientY + 14, window.innerHeight - podTip.offsetHeight - 8);
  podTip.style.left = x + 'px'; podTip.style.top = y + 'px';
});

// ---------- reschedule arcs & flashes ----------
function processUiEvents() {
  const now = performance.now();
  for (const e of uiEvents) {
    if (e.type === 'evictSoft' || e.type === 'evictHard' || e.type === 'oomKernel' ||
        e.type === 'oomContainer') {
      flashUntil.set(e.nodeIdx, now + 900);
    }
    if ((e.type === 'evictSoft' || e.type === 'evictHard' || e.type === 'drained') && e.podName) {
      const slot = parseInt(e.podName.split('-')[1], 10);
      if (!isNaN(slot)) lastEvictNodeBySlot.set(slot, e.nodeIdx);
    }
    if (e.type === 'scheduled' && e.detail && e.detail.indexOf('rescheduled') === 0 &&
        !reducedMotion.matches) {
      const slot = parseInt(e.podName.split('-')[1], 10);
      const from = lastEvictNodeBySlot.get(slot);
      if (from != null && from !== e.nodeIdx) {
        arcs.push({ from, to: e.nodeIdx, born: now });
        lastEvictNodeBySlot.delete(slot);
      }
    }
  }
  uiEvents = [];
  if (arcs.length > 12) arcs.splice(0, arcs.length - 12);
}
function renderArcs() {
  const svg = $('arcs');
  const wrap = svg.parentElement;
  svg.setAttribute('viewBox', '0 0 ' + wrap.offsetWidth + ' ' + wrap.offsetHeight);
  const now = performance.now();
  arcs = arcs.filter(a => now - a.born < 1400);
  const cards = $('nodes').children;
  const center = (idx) => {
    for (const c of cards) {
      if (+c.dataset.idx === idx) {
        return [c.offsetLeft + c.offsetWidth / 2, c.offsetTop + 160];
      }
    }
    return null;
  };
  const parts = [];
  for (const a of arcs) {
    const p1 = center(a.from), p2 = center(a.to);
    if (!p1 || !p2) continue;
    const age = (now - a.born) / 1400;
    const midX = (p1[0] + p2[0]) / 2;
    const midY = Math.min(p1[1], p2[1]) - 60;
    parts.push('<path d="M' + p1[0] + ' ' + p1[1] + ' Q' + midX + ' ' + midY +
      ' ' + p2[0] + ' ' + p2[1] + '" fill="none" stroke="var(--st-serious)"' +
      ' stroke-width="1.5" opacity="' + (0.7 * (1 - age)).toFixed(2) + '"/>' +
      '<circle cx="' + (p1[0] + (p2[0] - p1[0]) * age) + '" cy="' +
      (p1[1] + (p2[1] - p1[1]) * age - 60 * Math.sin(Math.PI * age)) +
      '" r="3.5" fill="var(--st-serious)" opacity="' + (1 - age).toFixed(2) + '"/>');
  }
  svg.innerHTML = parts.join('');
}

// ---------- charts ----------
const WINDOW = 600;
function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const g = (n) => cs.getPropertyValue(n).trim();
  return {
    ink2: g('--ink-2'), muted: g('--muted'), grid: g('--grid'),
    baseline: g('--baseline'), qg: g('--qos-g'), qb: g('--qos-b'),
    accent: g('--accent'), warn: g('--st-warn'), serious: g('--st-serious'),
    crit: g('--st-crit'),
  };
}
function setupCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  // The height attribute doubles as the design height, but assigning cv.height
  // below overwrites it — capture it once, or every frame re-scales by dpr.
  if (!cv.dataset.cssHeight) cv.dataset.cssHeight = cv.getAttribute('height');
  const w = cv.clientWidth, h = +cv.dataset.cssHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.height = h + 'px';
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [ctx, w, h];
}
let hoverX = null;
function renderChart() {
  const cv = $('chart');
  const [ctx, W, H] = setupCanvas(cv);
  const C = themeColors();
  ctx.clearRect(0, 0, W, H);
  const hist = sim.history.slice(-WINDOW);
  if (hist.length < 2) return;
  const stripH = 22, padR = 84, padT = 8;
  const plotH = H - stripH - padT - 4, plotW = W - padR;
  const yMax = Math.max(hist[hist.length - 1].capacity,
    hist.reduce((m, s) => Math.max(m, s.usage), 0)) * 1.06;
  const x = (i) => i / Math.max(1, hist.length - 1) * plotW;
  const y = (v) => padT + plotH - (v / yMax) * plotH;

  // grid: quarters of capacity
  const cap = hist[hist.length - 1].capacity;
  ctx.font = '10px ' + getComputedStyle(document.body).fontFamily;
  for (const f of [0.25, 0.5, 0.75]) {
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y(cap * f)); ctx.lineTo(plotW, y(cap * f)); ctx.stroke();
  }
  // capacity + allocatable references
  const alloc = hist[hist.length - 1].allocatable;
  for (const [v, col, lab] of [[cap, C.baseline, 'capacity ' + fmtMi(cap)],
                               [alloc, C.muted, 'allocatable']]) {
    ctx.strokeStyle = col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y(v)); ctx.lineTo(plotW, y(v)); ctx.stroke();
    ctx.fillStyle = C.muted;
    ctx.fillText(lab, plotW + 6, y(v) + 3);
  }
  // series
  const line = (key, col) => {
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath();
    hist.forEach((s, i) => { i ? ctx.lineTo(x(i), y(s[key])) : ctx.moveTo(x(i), y(s[key])); });
    ctx.stroke();
  };
  line('committed', C.qb);
  line('usage', C.qg);
  // direct labels at line ends
  const last = hist[hist.length - 1];
  ctx.fillStyle = C.ink2;
  ctx.fillText('working set', plotW + 6, y(last.usage) + 3);
  ctx.fillText('requests', plotW + 6, y(last.committed) + 3);
  // event strip
  const sy = H - stripH;
  ctx.strokeStyle = C.grid;
  ctx.beginPath(); ctx.moveTo(0, sy - 2); ctx.lineTo(plotW, sy - 2); ctx.stroke();
  hist.forEach((s, i) => {
    let yy = H - 3;
    const mark = (n, col) => {
      if (!n) return;
      ctx.fillStyle = col;
      ctx.fillRect(x(i) - 1, yy - 5, 2.5, 5);
      yy -= 6;
    };
    mark(s.kills.es + s.kills.eh, C.serious);
    mark(s.kills.ok, C.crit);
    mark(s.kills.oc, C.warn);
  });
  // hover crosshair
  const tip = $('chartTip');
  if (hoverX != null && hoverX <= plotW) {
    const i = Math.round(hoverX / plotW * (hist.length - 1));
    const s = hist[Math.max(0, Math.min(hist.length - 1, i))];
    ctx.strokeStyle = C.muted; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x(i), padT); ctx.lineTo(x(i), H - 2); ctx.stroke();
    const kills = s.kills.es + s.kills.eh + s.kills.ok + s.kills.oc;
    tip.innerHTML = '';
    const rows = [
      't=' + s.tick + 's',
      'working set ' + fmtMi(Math.round(s.usage)),
      'requests ' + fmtMi(Math.round(s.committed)),
      'pending ' + s.pending + ' · pressure nodes ' + s.pressureNodes,
    ];
    if (kills) rows.push('kills: evict ' + (s.kills.es + s.kills.eh) +
      ' · kOOM ' + s.kills.ok + ' · cOOM ' + s.kills.oc);
    for (const r of rows) {
      const d = document.createElement('div'); d.textContent = r; tip.appendChild(d);
    }
    tip.style.display = 'block';
    const tx = Math.min(x(i) + 12, W - 190);
    tip.style.left = tx + 'px'; tip.style.top = '10px';
  } else {
    tip.style.display = 'none';
  }
}
$('chart').addEventListener('mousemove', (e) => {
  hoverX = e.offsetX;
});
$('chart').addEventListener('mouseleave', () => { hoverX = null; });

function renderPending() {
  const cv = $('pending');
  const [ctx, W, H] = setupCanvas(cv);
  const C = themeColors();
  ctx.clearRect(0, 0, W, H);
  const hist = sim.history.slice(-WINDOW);
  if (hist.length < 2) return;
  const max = Math.max(5, hist.reduce((m, s) => Math.max(m, s.pending), 0));
  const x = (i) => i / Math.max(1, hist.length - 1) * (W - 84);
  const y = (v) => 3 + (H - 7) * (1 - v / max);
  ctx.strokeStyle = C.accent; ctx.lineWidth = 2; ctx.lineJoin = 'round';
  ctx.beginPath();
  hist.forEach((s, i) => { i ? ctx.lineTo(x(i), y(s.pending)) : ctx.moveTo(x(i), y(s.pending)); });
  ctx.stroke();
  ctx.fillStyle = C.muted;
  ctx.font = '10px ' + getComputedStyle(document.body).fontFamily;
  ctx.fillText('max ' + max, W - 78, 12);
  $('pendingNow').textContent = hist[hist.length - 1].pending;
}

// ---------- event log ----------
const KIND_LABEL = {
  scheduled: 'sched', evictSoft: 'evict-soft', evictHard: 'evict-hard',
  oomKernel: 'oom-kernel', oomContainer: 'oom-limit', pressureOn: 'pressure+',
  pressureOff: 'pressure-', restart: 'restart', leakInjected: 'leak!', drained: 'drained',
};
function renderLog() {
  const log = $('log');
  const evs = sim.events.slice(-140).reverse();
  const frag = document.createDocumentFragment();
  for (const e of evs) {
    const row = document.createElement('div'); row.className = 'row';
    const t = document.createElement('span'); t.className = 't';
    t.textContent = e.tick + 's';
    const k = document.createElement('span'); k.className = 'k ' + e.type;
    k.textContent = KIND_LABEL[e.type] || e.type;
    const d = document.createElement('span'); d.className = 'd';
    d.textContent = (e.nodeIdx != null && e.nodeIdx >= 0 ? 'node-' + (e.nodeIdx + 1) + ' ' : '') +
      (e.podName ? e.podName + ' ' : '') + (e.detail || '');
    row.appendChild(t); row.appendChild(k); row.appendChild(d);
    frag.appendChild(row);
  }
  log.replaceChildren(frag);
}

// ---------- main loop ----------
function render() {
  processUiEvents();
  renderTiles();
  renderNodes();
  renderArcs();
  renderChart();
  renderPending();
  renderLog();
}
function frame(now) {
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;
  if (running) {
    acc += dt * speed;
    const n = Math.min(120, Math.floor(acc));
    if (n > 0) { acc -= n; doTicks(n); }
  }
  if (now - lastRender > 90 || arcs.length) {
    lastRender = now;
    render();
  } else if (hoverX != null) {
    renderChart();
  }
  requestAnimationFrame(frame);
}

// ---------- wiring ----------
$('btnPlay').addEventListener('click', () => {
  running = !running;
  $('btnPlay').textContent = running ? 'Pause' : 'Play';
});
$('btnStep').addEventListener('click', () => { doTicks(1); render(); });
$('speed').addEventListener('change', (e) => { speed = +e.target.value; });
$('btnReset').addEventListener('click', () => { resetSim(true); render(); });
$('btnLeak').addEventListener('click', () => { sim.injectLeak(); render(); });

buildControls();
buildPresets();
buildTiles();
doTicks(1);
render();
requestAnimationFrame(frame);

// test hooks (used by the headless browser check)
window.__sim = () => sim;
window.__advance = (n) => { doTicks(n); render(); };
window.__setParams = (patch) => {
  Object.assign(uiParams, patch); sim.setParams(patch); syncControls();
};
window.__reset = (s) => { if (s != null) seed = s; resetSim(false); render(); };
})();
