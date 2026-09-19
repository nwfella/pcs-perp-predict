#!/usr/bin/env node
/* PCS-Perp-Predict — information-coefficient study.
 *
 * The backtest says the headline model is ~zero expectancy. This asks the more
 * useful question: which of the 22 facets actually carry information about the
 * next move, and which are noise?
 *
 * For every sampled bar we record each factor's score and the forward return
 * over several horizons, then compute the Pearson information coefficient (IC)
 * between them. A factor with IC indistinguishable from zero is not earning its
 * weight, no matter how sensible it sounds.
 *
 * Overlapping forward windows are serially correlated, which inflates a naive
 * t-statistic, so the reported t is computed on a NON-overlapping subset (one
 * sample every `horizon` bars). The all-samples IC is also reported for a
 * tighter point estimate.
 *
 * Usage: node scripts/ic_study.mjs [horizons] [bars]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const D = require(path.join(root, 'src/data.js'));
const E = require(path.join(root, 'src/engine.js'));
const I = require(path.join(root, 'src/indicators.js'));

const SYMBOLS = process.env.SYMBOLS
  ? process.env.SYMBOLS.split(',')
  : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT',
     'LINKUSDT', 'AVAXUSDT', 'CAKEUSDT', '1000PEPEUSDT', 'ENAUSDT', 'SUIUSDT'];

const HORIZONS = (process.argv[2] || '6,24,72').split(',').map(Number);
const BARS = parseInt(process.argv[3] || '400', 10);
const WARMUP = parseInt(process.argv[4] || '300', 10);
const STEP = 2;
const MAXH = Math.max(...HORIZONS);

/* The engine reads its signal series from ctx.bars['1h']. Feeding a different
 * base timeframe into that slot lets the same factor code be tested over much
 * longer windows (4h -> ~250 days, 1d -> ~4 years) to see whether any edge is
 * stable across regimes or just an artefact of one sample. */
const BASE = process.env.BASE || '1h';
const SLOTS = { '1h': ['1h', '4h', '1d'], '4h': ['4h', '1d', '1d'], '1d': ['1d', '1d', '1d'] }[BASE];
if (!SLOTS) { console.error('BASE must be 1h, 4h or 1d'); process.exit(1); }

const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 8) return { r: 0, n: 0 };
  const mx = mean(x.slice(0, n)), my = mean(y.slice(0, n));
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx, b = y[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (!dx || !dy) return { r: 0, n };
  return { r: num / Math.sqrt(dx * dy), n };
}

(async () => {
  // factorId -> { scores: [], fwd: {h: []}, sampleIdx: [] }
  const data = new Map();
  let compScores = [], compFwd = {};
  HORIZONS.forEach(h => { compFwd[h] = []; });
  const sampleBarIndex = [];
  let symbolBars = {};

  for (const sym of SYMBOLS) {
    process.stdout.write(`  ${sym} … `);
    let ctx;
    try { ctx = await D.loadContext(sym, { intervals: ['1h', '4h', '1d'] }); }
    catch (e) { console.log('data fail'); continue; }
    const bars = ctx.bars[BASE];
    if (!bars || bars.length < WARMUP + MAXH + 5) { console.log('insufficient'); continue; }

    const mid = ctx.bars[SLOTS[1]] || ctx.bars['4h'];
    const high = ctx.bars[SLOTS[2]] || ctx.bars['1d'];

    const end = bars.length - 1 - MAXH;
    let count = 0;
    for (let i = WARMUP; i <= end; i += STEP) {
      const cut = bars[i].ct;
      const sliceTo = (arr) => { if (!arr) return []; for (let k = arr.length - 1; k >= 0; k--) if (arr[k].ct <= cut) return arr.slice(0, k + 1); return []; };
      const sub = {
        symbol: sym,
        bars: { '1h': bars.slice(0, i + 1), '4h': sliceTo(mid), '1d': sliceTo(high) },
        deriv: { ticker: { lastPrice: bars[i].c }, depth: null, lastFundingRate: null },
        fundingHist: (ctx.fundingHist || []).filter(f => Number(f.fundingTime) <= cut),
        oiHist: null
      };
      const res = E.analyze(sub, { interval: '1h' });
      if (!res.ok) continue;
      const base = bars[i].c;
      res.groups.forEach(g => g.factors.forEach(f => {
        if (!f.available || f.weight <= 0) return;
        if (!data.has(f.id)) {
          const fwd = {}; HORIZONS.forEach(h => { fwd[h] = []; });
          data.set(f.id, { name: f.name, group: f.group, weight: f.weight, scores: [], fwd, idx: [] });
        }
        const rec = data.get(f.id);
        rec.scores.push(f.score);
        HORIZONS.forEach(h => rec.fwd[h].push((bars[i + h].c - base) / base * 100));
        rec.idx.push(i);
      }));
      compScores.push(res.composite);
      HORIZONS.forEach(h => compFwd[h].push((bars[i + h].c - base) / base * 100));
      sampleBarIndex.push(i);
      count++;
    }
    symbolBars[sym] = count;
    console.log(`${count} samples`);
  }

  const total = compScores.length;
  if (!total) { console.error('no samples collected'); process.exit(1); }

  const rows = [];
  const evalIC = (scores, fwd, overlapEvery) => {
    // all-samples point estimate
    const all = pearson(scores, fwd);
    // non-overlapping subset for an honest t-stat
    const xs = [], ys = [];
    for (let i = 0; i < scores.length; i += overlapEvery) { xs.push(scores[i]); ys.push(fwd[i]); }
    const sub = pearson(xs, ys);
    const t = sub.n > 2 && sub.r > -1 && sub.r < 1 ? sub.r * Math.sqrt((sub.n - 2) / (1 - sub.r * sub.r)) : 0;
    return { ic: all.r, n: all.n, icNonOverlap: sub.r, nNonOverlap: sub.n, t };
  };

  data.forEach((rec, id) => {
    const row = { id, name: rec.name, group: rec.group, weight: rec.weight, n: rec.scores.length, horizons: {} };
    HORIZONS.forEach(h => { row.horizons[h] = evalIC(rec.scores, rec.fwd[h], Math.max(1, Math.round(h / STEP))); });
    rows.push(row);
  });

  const compRow = { id: 'COMPOSITE', name: 'Weighted composite', group: '-', weight: 1, n: total, horizons: {} };
  HORIZONS.forEach(h => { compRow.horizons[h] = evalIC(compScores, compFwd[h], Math.max(1, Math.round(h / STEP))); });

  const mainH = HORIZONS[Math.min(1, HORIZONS.length - 1)];
  const sorted = rows.slice().sort((a, b) => Math.abs(b.horizons[mainH].ic) - Math.abs(a.horizons[mainH].ic));

  console.log(`\n=== Information coefficient, ${total} samples across ${Object.keys(symbolBars).length} symbols`);
  console.log('IC = Pearson correlation between the factor score at bar t and the forward return.');
  console.log(`t is computed on a NON-overlapping subset (every ${Math.max(1, Math.round(mainH / STEP))}th sample) to avoid serial-correlation inflation.\n`);

  const head = `factor                          grp  w     ${HORIZONS.map(h => 'IC' + h + 'h').join('      ')}   t(${mainH}h)`;
  console.log(head);
  console.log('-'.repeat(head.length + 4));
  sorted.forEach(r => {
    console.log(
      r.id.padEnd(6) + r.name.slice(0, 24).padEnd(25) +
      r.group.padEnd(5) + String(r.weight).padEnd(6) +
      HORIZONS.map(h => r.horizons[h].ic.toFixed(3).padStart(7)).join('  ') +
      r.horizons[mainH].t.toFixed(2).padStart(10)
    );
  });
  console.log('-'.repeat(head.length + 4));
  console.log('COMPOSITE'.padEnd(31) + '-'.padEnd(5) + '1'.padEnd(6) +
    HORIZONS.map(h => compRow.horizons[h].ic.toFixed(3).padStart(7)).join('  ') +
    compRow.horizons[mainH].t.toFixed(2).padStart(10));

  const out = {
    generatedAt: new Date().toISOString(),
    engineVersion: E.VERSION,
    baseTimeframe: BASE,
    samples: total, step: STEP, symbols: Object.keys(symbolBars), horizons: HORIZONS,
    composite: compRow,
    factors: sorted,
    note: 'Overlapping forward windows inflate naive significance; the reported t uses a non-overlapping subset. Treat |t| < 2 as indistinguishable from noise.'
  };
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const dest = path.join(root, 'data', BASE === '1h' ? 'ic_study.json' : 'ic_study_' + BASE + '.json');
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  console.log('\nwrote ' + path.relative(root, dest));
})().catch(e => { console.error(e); process.exit(1); });
