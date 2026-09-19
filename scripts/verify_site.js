#!/usr/bin/env node
/* PCS-Perp-Predict — build verification gate.
 *
 * Loads the BUILT index.html in jsdom with scripts enabled and a stubbed canvas,
 * serving recorded live Aster responses from tests/fixtures.json, then asserts
 * the whole render path actually runs: pair picker populated from the real
 * symbol universe, verdict + gauge produced, evidence rows rendered, plan and
 * sizing present, the model-validation tables populated from the baked data,
 * charts drawn, and the honesty escrow (measured expectancy + disclaimer) on the
 * page.
 *
 * This is the gate that would have caught a broken module order, a missing
 * validation payload, a canvas that never draws, or a verdict card that renders
 * an empty box.
 *
 * Usage:  npm i -D jsdom  &&  node scripts/verify_site.js
 * Exit code 0 = pass.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const file = path.resolve(__dirname, '..', 'index.html');
const fixturePath = path.resolve(__dirname, '..', 'tests', 'fixtures.json');

if (!fs.existsSync(file)) { console.error('index.html missing — run: node scripts/build.mjs'); process.exit(1); }
if (!fs.existsSync(fixturePath)) { console.error('tests/fixtures.json missing — run: node scripts/record_fixtures.mjs'); process.exit(1); }

const html = fs.readFileSync(file, 'utf8');
const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

const fails = [];
const info = [];
const ok = (cond, msg) => (cond ? info.push('  ok   ' + msg) : fails.push('  FAIL ' + msg));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- canvas stub ---- */
const draw = { lines: 0, rects: 0, texts: [], gradients: 0, strokes: 0, paths: 0 };
function stubCtx() {
  const noop = () => {};
  return new Proxy({
    fillRect: () => draw.rects++,
    strokeRect: () => draw.rects++,
    stroke: () => draw.strokes++,
    fill: () => draw.paths++,
    fillText: (t) => draw.texts.push(String(t)),
    createLinearGradient: () => { draw.gradients++; return { addColorStop() {} }; },
    measureText: () => ({ width: 10 }),
    getImageData: () => ({ data: new Uint8ClampedArray(8) }),
    moveTo: () => draw.lines++, lineTo: () => draw.lines++,
    beginPath: noop, closePath: noop, arc: noop, setTransform: noop,
    setLineDash: noop, save: noop, restore: noop, clearRect: noop, translate: noop, scale: noop,
  }, { get: (t, p) => (p in t ? t[p] : (typeof p === 'string' && p.startsWith('set') ? noop : undefined)) });
}
Object.defineProperty(globalThis, 'requestAnimationFrame', { value: (cb) => setTimeout(cb, 0), writable: true });

/* ---- fetch stub: serve recorded fixtures, and only those ---- */
const served = [];
function installFetch(win) {
  win.fetch = async (url) => {
    const u = String(url);
    served.push(u);
    const q = u.replace(fixtures.source, '');
    if (q.startsWith('/fapi/v1/exchangeInfo')) {
      return { ok: true, status: 200, json: async () => fixtures.exchangeInfo };
    }
    const hit = Object.keys(fixtures.responses).find((k) => norm(k) === norm(q));
    if (hit && fixtures.responses[hit] !== null) {
      return { ok: true, status: 200, json: async () => fixtures.responses[hit] };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}
const norm = (p) => p.replace(/\/fapi\/v1\//, '').split('&').sort().join('&');

(async () => {
  const vc = new VirtualConsole();
  const consoleErrors = [];
  vc.on('jsdomError', (e) => consoleErrors.push('jsdomError: ' + (e.message || e)));
  vc.on('error', (...a) => consoleErrors.push('console.error: ' + a.join(' ')));

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    url: 'https://example.test/'
  });
  const win = dom.window;
  installFetch(win);
  win.HTMLCanvasElement.prototype.getContext = () => stubCtx();
  Object.defineProperty(win.HTMLCanvasElement.prototype, 'clientWidth', { get: () => 720, configurable: true });
  win.WebSocket = class { constructor() {} close() {} send() {} };  // stream is an enhancement, not the render path

  // let boot() -> pairs() -> loadContext() -> renderAll() settle
  for (let i = 0; i < 60; i++) {
    await sleep(50);
    const t = win.document.getElementById('statusText');
    if (t && /Live|Error|Failed/.test(t.textContent)) break;
  }
  await sleep(400);

  const doc = win.document;
  const txt = (id) => { const e = doc.getElementById(id); return e ? e.textContent : ''; };
  const htmlOf = (id) => { const e = doc.getElementById(id); return e ? e.innerHTML : ''; };
  const allText = doc.body.textContent || '';

  /* ---- module wiring ---- */
  ok(win.PPIndicators && typeof win.PPIndicators.ema === 'function', 'PPIndicators loaded');
  ok(win.PPEngine && typeof win.PPEngine.analyze === 'function', 'PPEngine loaded');
  ok(win.PPData && typeof win.PPData.loadContext === 'function', 'PPData loaded');
  ok(win.PPBacktest && typeof win.PPBacktest.run === 'function', 'PPBacktest loaded');
  ok(win.PPChart && typeof win.PPChart.drawPrice === 'function', 'PPChart loaded');
  ok(!!win.PP_VALIDATION, 'validation payload baked in');
  ok(win.PP_VALIDATION && !!win.PP_VALIDATION.ic, 'IC study baked in');
  ok(win.PP_VALIDATION && !!win.PP_VALIDATION.oos, 'out-of-sample test baked in');
  ok(win.PP_VALIDATION && !!win.PP_VALIDATION.calibration, 'exit-policy calibration baked in');

  /* ---- boot state ---- */
  ok(!/Error|Failed/.test(txt('statusText')), 'status bar is not in an error state ("' + txt('statusText') + '")');
  ok(!/Booting/.test(txt('statusText')), 'boot completed');

  /* ---- pair picker ---- */
  const picker = htmlOf('picker');
  ok(/perpetuals on PCS Perps/.test(picker), 'pair picker rendered with symbol count');
  const pickerCount = (picker.match(/(\d+)\s+perpetuals/) || [])[1];
  ok(Number(pickerCount) === fixtures.exchangeInfo.symbols.length,
    'pair count matches fixture (' + pickerCount + ' vs ' + fixtures.exchangeInfo.symbols.length + ')');
  ok(/BTCUSDT/.test(picker), 'picker input shows the active symbol');

  /* ---- verdict ---- */
  const v = htmlOf('verdictCard');
  ok(/LONG|SHORT|SETUP LONG|SETUP SHORT|NO TRADE/.test(v), 'verdict card shows a verdict');
  ok(/gauge-bar/.test(v), 'composite gauge rendered');
  ok(/gauge-needle/.test(v), 'gauge needle positioned');
  ok(/Composite/.test(v) && /Confidence/.test(v), 'key metrics rendered');
  ok(/lean (LONG|SHORT|NEUTRAL)/.test(v), 'directional lean is always shown');
  ok(/What the .* profile actually measured/.test(v), 'verdict carries its own measured expectancy');
  ok(/NOT statistically significant|statistically significant/.test(v), 'expectancy states significance honestly');
  ok(/setup — gates not passed|conviction|neutral — no direction/.test(v), 'tier label distinguishes trade from setup');

  /* ---- evidence ---- */
  const f = htmlOf('factorCard');
  const factorRows = (f.match(/class="factor/g) || []).length;
  ok(factorRows >= 20, 'at least 20 factor rows rendered (got ' + factorRows + ')');
  ok((f.match(/class="fid"/g) || []).length >= 20, 'factor ids rendered');
  ['Trend', 'Momentum', 'Volatility', 'Volume', 'Derivatives', 'Levels'].forEach((g) => {
    ok(f.indexOf(g) !== -1, 'factor group present: ' + g);
  });
  ok(/context only|muted/.test(f) || win.PPEngine.DEFAULT_PROFILE === 'balanced',
    'muted-by-profile factors are labelled when a fitted profile is active');
  ok(/Higher-timeframe context/.test(f), 'higher-timeframe context section rendered');

  /* ---- plan + sizing ---- */
  const p = htmlOf('planCard');
  ok(/Trade plan/.test(p), 'trade plan card rendered');
  const hasPlan = /plan-row entry/.test(p);
  if (hasPlan) {
    ok(/plan-row stop/.test(p), 'stop level rendered');
    ok((p.match(/plan-row tp/g) || []).length === 3, 'three target levels rendered');
    ok(/Stop distance/.test(p), 'stop distance metric present');
    ok(/Attainable R/.test(p), 'attainable R metric present');
    ok(/Reachable targets/.test(p), 'reachable-target count present');
  } else {
    ok(/pinned against the next structure|gates below blocked a trade|composite is neutral/.test(p),
      'absent levels are explained instead of invented');
  }
  const sz = htmlOf('sizeCard');
  ok(/Position sizing/.test(sz), 'sizing card rendered');
  ok(/sz_equity|Trade plan exists|Sizing appears/.test(sz), 'sizing card has inputs or a plan');

  /* ---- heatmap ---- */
  const h = htmlOf('heatCard');
  ok((h.match(/heat-cell/g) || []).length >= 16, 'multi-timeframe heatmap cells rendered');
  ['15m', '1h', '4h', '1d'].forEach((tf) => ok(h.indexOf('>' + tf + '<') !== -1, 'heatmap row: ' + tf));

  /* ---- derivatives ---- */
  const d = htmlOf('derivCard');
  ['Mark price', 'Index price', 'Basis', 'Funding rate', 'Open interest'].forEach((k) => {
    ok(d.indexOf(k) !== -1, 'derivatives row: ' + k);
  });
  ok(/no history endpoint|no series/.test(d), 'missing open-interest history is disclosed, not faked');

  /* ---- validation tables ---- */
  const val = htmlOf('validCard');
  ok(/Model validation/.test(val), 'validation panel rendered');
  ok(/Information coefficient/.test(val), 'IC methodology explained');
  ok((val.match(/<tr>/g) || []).length >= 25, 'IC table rows rendered (got ' + (val.match(/<tr>/g) || []).length + ')');
  ok(/Out-of-sample walk-forward/.test(val), 'OOS section rendered');
  ok(/held out/.test(val), 'held-out rows labelled');
  ok(/opposite signs in the two columns|measuring noise/.test(val),
    'OOS result reported honestly (sign flip called out, not sold as an edge)');
  ok(/held out/.test(val) && /not<\/b> of the <b>gates|of the <b>weights<\/b> but not of the <b>gates/.test(val.replace(/\s+/g, ' ')),
    'the panel states which parts the held-out column does and does not test');
  ok(/Exit policy comparison/.test(val), 'exit-policy comparison rendered');
  ok(/Balanced prior/.test(val), 'profile labels rendered');
  const validationFactorIds = ['A1', 'B3', 'C1', 'D2', 'E1', 'F2'];
  validationFactorIds.forEach((id) => ok(val.indexOf('>' + id + '<') !== -1, 'IC row for ' + id));

  /* ---- chart actually drew ---- */
  ok(draw.rects > 20, 'candles drawn on canvas (fillRect x' + draw.rects + ')');
  ok(draw.lines > 20, 'line work drawn on canvas (x' + draw.lines + ')');
  ok(draw.texts.some((t) => /STOP|ENTRY|TP1/.test(t)) === hasPlan, 'plan levels drawn to canvas iff a plan exists');
  ok(draw.texts.length > 0, 'axis labels drawn');

  /* ---- backtest panel ---- */
  const bt = htmlOf('btCard');
  ok(/Walk-forward backtest/.test(bt), 'backtest panel rendered');
  ok(/Run backtest/.test(bt), 'backtest button rendered');
  ok(/stop is assumed to fill first|assumed to fill first/.test(bt), 'backtest states its pessimistic fill assumption');

  /* ---- watchlist ---- */
  ok(/Watchlist/.test(htmlOf('watchCard')), 'watchlist rendered');

  /* ---- collapsible panels + persistence ---- */
  const cardIds = ['verdictCard', 'chartCard', 'planCard', 'sizeCard', 'heatCard',
                   'factorCard', 'derivCard', 'validCard', 'btCard', 'watchCard'];
  let disclosureCount = 0, collapsedByDefault = 0, expandedByDefault = 0;
  cardIds.forEach((id) => {
    const card = doc.querySelector('#' + id + ' .card');
    if (!card) { fails.push('  FAIL missing card container #' + id); return; }
    const h2 = card.querySelector('h2');
    if (!h2) { fails.push('  FAIL #' + id + ' has no header'); return; }
    const btn = h2.querySelector('button.disclosure');
    if (btn) disclosureCount++;
    ok(h2.getAttribute('data-collapse') === id, '#' + id + ' header is a collapse target');
    ok(card.querySelector('.card-body') !== null, '#' + id + ' content is wrapped in a foldable body');
    if (card.classList.contains('collapsed')) collapsedByDefault++; else expandedByDefault++;
    const aria = h2.getAttribute('aria-expanded');
    ok(aria === String(!card.classList.contains('collapsed')), '#' + id + ' aria-expanded matches visual state');
  });
  ok(disclosureCount === cardIds.length, 'every card has a disclosure caret (' + disclosureCount + '/' + cardIds.length + ')');
  ok(collapsedByDefault >= 4, 'busy panels start folded (' + collapsedByDefault + ' folded, ' + expandedByDefault + ' open)');
  ok(expandedByDefault >= 4, 'primary panels start open (' + expandedByDefault + ' open)');

  const factorCardEl = doc.querySelector('#factorCard .card');
  ok(factorCardEl.classList.contains('collapsed'), 'evidence panel is folded on first load');
  ok(!doc.querySelector('#verdictCard .card').classList.contains('collapsed'), 'verdict panel is open on first load');

  /* toggling must flip the class AND persist */
  const vh2 = doc.querySelector('#verdictCard .card h2');
  vh2.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const vCard = doc.querySelector('#verdictCard .card');
  ok(vCard.classList.contains('collapsed'), 'clicking a header folds the panel');
  ok((win.localStorage.getItem('ppp.collapsedCards') || '').indexOf('"verdictCard":true') !== -1,
    'fold state persisted to localStorage');
  vh2.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  ok(!vCard.classList.contains('collapsed'), 'clicking again unfolds the panel');
  ok((win.localStorage.getItem('ppp.collapsedCards') || '').indexOf('"verdictCard":false') !== -1,
    'unfold state persisted to localStorage');

  /* collapse/expand all */
  ok(doc.getElementById('collapseAll') !== null && doc.getElementById('expandAll') !== null,
    'collapse-all / expand-all controls exist');
  doc.getElementById('expandAll').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  const anyCollapsed = cardIds.filter((id) => {
    const c = doc.querySelector('#' + id + ' .card');
    return c && c.classList.contains('collapsed');
  });
  ok(anyCollapsed.length === 0, 'expand-all unfolds every panel' + (anyCollapsed.length ? ' (still folded: ' + anyCollapsed.join(',') + ')' : ''));
  doc.getElementById('collapseAll').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  const allCollapsed = cardIds.filter((id) => {
    const c = doc.querySelector('#' + id + ' .card');
    return c && c.classList.contains('collapsed');
  });
  ok(allCollapsed.length === cardIds.length, 'collapse-all folds every panel');
  doc.getElementById('expandAll').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(60);

  /* factor groups fold independently and persist separately */
  const gHeads = doc.querySelectorAll('.group-head[data-group]');
  ok(gHeads.length >= 6, 'factor groups are individually collapsible (' + gHeads.length + ')');
  const g0 = gHeads[0];
  g0.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  ok(g0.closest('.group').classList.contains('collapsed'), 'clicking a group header folds that group');
  ok((win.localStorage.getItem('ppp.collapsedGroups') || '').length > 4, 'group fold state persisted');
  g0.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);

  /* ---- risk-gate selector ---- */
  const strictSeg = doc.getElementById('strictSeg');
  ok(strictSeg !== null, 'risk-gate selector rendered');
  const sBtns = strictSeg ? strictSeg.querySelectorAll('button[data-s]') : [];
  ok(sBtns.length === 3, 'three strictness presets offered (got ' + sBtns.length + ')');
  const activeBtn = strictSeg && strictSeg.querySelector('button[data-s].active');
  ok(!!activeBtn && activeBtn.getAttribute('data-s') === 'balanced', 'balanced preset is the default');
  if (sBtns.length === 3) {
    sBtns[2].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(80);
    /* LS.set stores JSON, so the raw string is quoted */
    ok((win.localStorage.getItem('ppp.strictness') || '').indexOf('aggressive') !== -1, 'strictness choice persisted');
    ok(/aggressive/.test(htmlOf('verdictCard')), 'verdict reflects the selected strictness');
    doc.querySelector('#strictSeg button[data-s="balanced"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(80);
  }

  ok(allText.indexOf('0xe09e6c33b444d246F1005BdCd404ff33Cb709EcA') !== -1, 'donation address present as static text');
  ok(/Support this project/.test(allText), 'donation ask present');
  ok(/Not financial advice/.test(allText), 'disclaimer present');
  ok(/has not demonstrated a statistically significant edge/.test(allText), 'disclaimer states the measured result');
  ok(/fapi\.asterdex\.com/.test(allText), 'data source disclosed');
  ok(/MIT licensed/.test(allText), 'licence shown');
  ok(txt('engineVer') !== '—' && txt('engineVer').length > 0, 'engine version displayed (' + txt('engineVer') + ')');

  /* ---- no silent failures ---- */
  ok(served.length >= 6, 'data layer issued requests (' + served.length + ' to the API)');
  const realErrors = consoleErrors.filter((e) => !/Not implemented|Could not parse CSS|WebSocket/.test(e));
  ok(realErrors.length === 0, 'no script errors during boot' + (realErrors.length ? ' -> ' + realErrors.slice(0, 3).join(' | ') : ''));

  /* ---- engine invariants that must hold in the shipped bundle ---- */
  const E = win.PPEngine;
  const declared = E.sumWeights(E.WEIGHTS.balanced);
  ok(Math.abs(declared - 1) < 0.005, 'balanced weights sum to 1.00 (got ' + declared.toFixed(4) + ')');
  ok(E.DEFAULT_PROFILE === 'balanced', 'default profile is the unfitted prior');
  const r = E.analyze({
    symbol: 'X', bars: {
      '1h': fixtures.responses['/fapi/v1/klines?symbol=' + fixtures.symbol + '&interval=1h&limit=1000'].map((x) => ({
        t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5], ct: +x[6], q: +x[7], n: +x[8], tbb: +x[9], tba: +x[10]
      }))
    },
    deriv: { ticker: { quoteVolume: 1e9, lastPrice: 0 }, depth: null }, fundingHist: [], oiHist: null
  }, { interval: '1h' });
  ok(r.ok, 'engine analyses a bare 1h series without 4h/1d');
  if (r.ok) {
    ok(Math.abs(r.composite) <= 100, 'composite within [-100,100] (got ' + r.composite + ')');
    ok(r.confidence >= 0 && r.confidence <= 100, 'confidence within [0,100]');
    ok(typeof r.lean === 'string' && /LONG|SHORT|NEUTRAL/.test(r.lean), 'a directional lean is always computed');
    ok(!r.hasTrade || !!r.plan, 'a gate-passed trade always ships a plan');
    ok(!r.hasSetup || !r.hasTrade, 'setup and trade are mutually exclusive');
    if (r.hasTrade) ok(r.plan && r.plan.targets.length === 3, 'a trade ships the full three-target ladder');
    if (r.plan) {
      const sideOK = r.plan.dir > 0 ? r.plan.stop < r.plan.entry : r.plan.stop > r.plan.entry;
      ok(sideOK, 'stop is on the correct side of entry for a ' + r.plan.side);
      r.plan.targets.forEach((t) => {
        const tpOK = r.plan.dir > 0 ? t.price > r.plan.entry : t.price < r.plan.entry;
        ok(tpOK, 'target ' + t.r + 'R is beyond entry');
        ok((t.r <= r.plan.attainableR) === t.reachable,
          'target ' + t.r + 'R reachable flag is consistent with attainableR');
      });
      /* the stop must never be tighter than the ATR floor it advertises */
      ok(r.plan.stopDist / r.plan.atr >= 0.599,
        'stop is never tighter than the ' + 0.6 + 'x ATR floor (got ' + (r.plan.stopDist / r.plan.atr).toFixed(2) + 'x)');
    }
    /* room-blocked rows must not publish levels at all */
    ok(!r.roomBlocked || r.plan === null, 'a room-blocked setup withholds its levels');
    const blocked = r.blockers.length > 0;
    ok(r.hasTrade ? !blocked : true, 'a trade is only emitted with zero blockers');
    ok(blocked || r.hasTrade, 'a blocked analysis never claims to be a trade');
    ok(r.blockers.every((b) => b && b.code && b.text), 'every blocker carries a stable code and readable text');
  }

  /* ---- report ---- */
  console.log('\n--- PCS-Perp-Predict build verification ---\n');
  info.forEach((l) => console.log(l));
  if (fails.length) {
    console.log('');
    fails.forEach((l) => console.log(l));
    console.log('\n' + fails.length + ' FAILED, ' + info.length + ' passed\n');
    process.exit(1);
  }
  console.log('\nall ' + info.length + ' assertions passed\n');
  dom.window.close();
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
