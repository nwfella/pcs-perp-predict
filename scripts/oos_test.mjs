#!/usr/bin/env node
/* PCS-Perp-Predict — out-of-sample stress test.
 *
 * The IC weight profile in engine.js was fitted using measured information
 * coefficients. Fitting weights on data and then reporting performance on the
 * SAME data proves nothing, so this splits the symbol universe in two:
 *
 *   FIT   — the symbols whose IC drove the reweighting
 *   TEST  — symbols the weights never saw
 *
 * Both weight profiles are run over both halves. The gap between the two is the
 * honest measure of how much of the improvement is real.
 *
 * Usage: node scripts/oos_test.mjs [bars] [warmup]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const D = require(path.join(root, 'src/data.js'));
const B = require(path.join(root, 'src/backtest.js'));
const I = require(path.join(root, 'src/indicators.js'));

const FIT = (process.env.FIT || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT').split(',');
const TEST = (process.env.TEST || 'LINKUSDT,AVAXUSDT,CAKEUSDT,1000PEPEUSDT,ENAUSDT,SUIUSDT').split(',');
const BARS = parseInt(process.argv[2] || '400', 10);
const WARMUP = parseInt(process.argv[3] || '300', 10);

function summarize(trades) {
  const n = trades.length;
  if (!n) return { trades: 0 };
  const wins = trades.filter(t => t.netR > 0);
  const losses = trades.filter(t => t.netR <= 0);
  const gw = I.sum(wins.map(t => t.netR));
  const gl = Math.abs(I.sum(losses.map(t => t.netR)));
  const mean = I.sum(trades.map(t => t.netR)) / n;
  const sd = Math.sqrt(I.sum(trades.map(t => (t.netR - mean) ** 2)) / Math.max(1, n - 1));

  let eq = 10000, peak = eq, dd = 0, streak = 0, worst = 0;
  trades.forEach(t => {
    eq *= (1 + t.netR * 0.01);
    peak = Math.max(peak, eq);
    dd = Math.max(dd, (peak - eq) / peak * 100);
    if (t.netR <= 0) { streak++; worst = Math.max(worst, streak); } else streak = 0;
  });

  return {
    trades: n,
    winRate: wins.length / n * 100,
    avgR: mean,
    totalR: I.sum(trades.map(t => t.netR)),
    profitFactor: gl > 0 ? gw / gl : Infinity,
    maxDrawdownPct: dd,
    worstLosingStreak: worst,
    avgBarsHeld: I.sum(trades.map(t => t.barsHeld)) / n,
    stdDevR: sd,
    tStatistic: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0,
    longShare: trades.filter(t => t.side === 'LONG').length / n * 100,
    exitReasons: trades.reduce((a, t) => { a[t.exitReason] = (a[t.exitReason] || 0) + 1; return a; }, {})
  };
}

(async () => {
  const out = {
    generatedAt: new Date().toISOString(),
    engineVersion: null,
    method: {
      bars: BARS, warmup: WARMUP,
      costs: B.DEFAULTS.feePct + '% taker per leg + ' + B.DEFAULTS.slipPct + '% slippage per leg',
      fitSymbols: FIT, testSymbols: TEST,
      note: 'The IC weight profile was derived from measured information coefficients. FIT symbols informed that reweighting; TEST symbols are held out. A real edge shows up in the TEST column.'
    },
    sets: {}
  };

  const E = require(path.join(root, 'src/engine.js'));
  out.engineVersion = E.VERSION;

  const cached = {};
  for (const sym of [...FIT, ...TEST]) {
    process.stdout.write(`  loading ${sym} … `);
    try {
      cached[sym] = await D.loadContext(sym, { intervals: ['1h', '4h', '1d'] });
      console.log('ok');
    } catch (e) { console.log('fail: ' + e.message); }
  }

  for (const [name, syms] of [['fit', FIT], ['test', TEST]]) {
    out.sets[name] = { symbols: syms, profiles: {} };
    for (const profile of Object.keys(E.WEIGHTS)) {
      const trades = [];
      for (const sym of syms) {
        const ctx = cached[sym];
        if (!ctx) continue;
        const r = B.run(ctx, { bars: BARS, warmup: WARMUP, weights: profile });
        if (r.ok) trades.push(...r.trades);
      }
      out.sets[name].profiles[profile] = summarize(trades);
    }
  }

  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/oos_test.json'), JSON.stringify(out, null, 2));

  const fmt = s => s.trades
    ? `${String(s.trades).padStart(4)}  ${s.winRate.toFixed(1).padStart(5)}%  ${s.avgR.toFixed(3).padStart(7)}  ${s.totalR.toFixed(1).padStart(7)}  ${s.profitFactor.toFixed(2).padStart(5)}  ${s.maxDrawdownPct.toFixed(1).padStart(5)}%  ${s.tStatistic.toFixed(2).padStart(6)}`
    : '   0';

  console.log('\nset    profile    trades  winRate     avgR   totalR     PF   maxDD    t-stat');
  console.log('-'.repeat(76));
  for (const name of ['fit', 'test']) {
    for (const p of Object.keys(E.WEIGHTS)) {
      console.log(`${name.padEnd(7)}${p.padEnd(11)}${fmt(out.sets[name].profiles[p])}`);
    }
  }
  console.log('\nwrote data/oos_test.json');
})().catch(e => { console.error(e); process.exit(1); });
