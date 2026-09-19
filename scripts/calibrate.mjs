#!/usr/bin/env node
/* PCS-Perp-Predict — strategy calibration.
 *
 * Measures the strategy the engine ACTUALLY emits (full gate, not a threshold
 * sweep), pools the trades across symbols, compares exit policies on the same
 * signals, and records why bars get rejected.
 *
 * The output is written to data/calibration.json and baked into the shipped
 * page, so the app can state its own measured expectancy instead of implying an
 * edge it has not demonstrated.
 *
 * Usage: node scripts/calibrate.mjs [bars] [warmup]
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
const E = require(path.join(root, 'src/engine.js'));
const I = require(path.join(root, 'src/indicators.js'));

const SYMBOLS = process.env.SYMBOLS
  ? process.env.SYMBOLS.split(',')
  : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT',
     'LINKUSDT', 'AVAXUSDT', 'CAKEUSDT', '1000PEPEUSDT', 'ENAUSDT', 'SUIUSDT'];

const BARS = parseInt(process.argv[2] || '400', 10);
const WARMUP = parseInt(process.argv[3] || '300', 10);
const STRICT = process.env.STRICT || null;

/* Exit policies to compare on identical signals. */
const LADDERS = [
  { key: 'engine-default', label: '1.5R / 3R / 5R @ 40/35/25', targets: null },
  { key: 'tp1-only', label: '1.5R all out', targets: [{ r: 1.5, portion: 1 }] },
  { key: 'single-2R', label: '2R all out', targets: [{ r: 2, portion: 1 }] },
  { key: 'single-3R', label: '3R all out', targets: [{ r: 3, portion: 1 }] },
  { key: 'tight-ladder', label: '1R / 2R / 3R @ 50/30/20', targets: [{ r: 1, portion: 0.5 }, { r: 2, portion: 0.3 }, { r: 3, portion: 0.2 }] },
  { key: 'wide-ladder', label: '2R / 4R / 6R @ 40/35/25', targets: [{ r: 2, portion: 0.4 }, { r: 4, portion: 0.35 }, { r: 6, portion: 0.25 }] }
];

function pool(list) { return list.reduce((a, b) => a.concat(b), []); }

function pooledStats(tradeSets, opts, barsRefs) {
  const trades = pool(tradeSets);
  const n = trades.length;
  if (!n) return { trades: 0 };
  const wins = trades.filter(t => t.netR > 0);
  const losses = trades.filter(t => t.netR <= 0);
  const grossWin = I.sum(wins.map(t => t.netR));
  const grossLoss = Math.abs(I.sum(losses.map(t => t.netR)));
  const avgR = I.sum(trades.map(t => t.netR)) / n;

  // fixed-fractional equity across the pooled sequence, 1R = riskPct of equity
  let equity = opts.equity, peak = equity, maxDD = 0, streak = 0, worst = 0;
  const curve = [{ i: 0, equity }];
  trades.forEach((t, idx) => {
    equity *= (1 + t.netR * opts.riskPct / 100);
    curve.push({ i: idx + 1, equity });
    if (equity > peak) peak = equity;
    maxDD = Math.max(maxDD, peak > 0 ? (peak - equity) / peak * 100 : 0);
    if (t.netR <= 0) { streak++; worst = Math.max(worst, streak); } else streak = 0;
  });

  // per-trade R standard deviation -> t-statistic on the mean
  const mean = avgR;
  const sd = Math.sqrt(I.sum(trades.map(t => (t.netR - mean) ** 2)) / Math.max(1, n - 1));
  const tStat = sd > 0 ? mean / (sd / Math.sqrt(n)) : 0;

  const reasons = trades.reduce((a, t) => { a[t.exitReason] = (a[t.exitReason] || 0) + 1; return a; }, {});

  return {
    trades: n,
    winRate: wins.length / n * 100,
    avgR,
    totalR: I.sum(trades.map(t => t.netR)),
    grossWinR: grossWin,
    grossLossR: grossLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    maxDrawdownPct: maxDD,
    worstLosingStreak: worst,
    avgBarsHeld: I.sum(trades.map(t => t.barsHeld)) / n,
    avgCostR: I.sum(trades.map(t => t.costR)) / n,
    stdDevR: sd,
    tStatistic: tStat,
    longShare: trades.filter(t => t.side === 'LONG').length / n * 100,
    exitReasons: reasons,
    equityCurve: curve,
    finalEquity: equity
  };
}

(async () => {
  const perSymbol = {};
  const records = [];
  const tradeSets = {};
  LADDERS.forEach(l => { tradeSets[l.key] = []; });

  let totalBars = 0, totalBh = [];

  for (const sym of SYMBOLS) {
    process.stdout.write(`  ${sym} … `);
    let ctx;
    try {
      ctx = await D.loadContext(sym, { intervals: ['1h', '4h', '1d'] });
    } catch (e) {
      console.log('data fail: ' + e.message);
      continue;
    }
    if (!ctx.bars['1h'] || ctx.bars['1h'].length < WARMUP + 40) { console.log('insufficient history'); continue; }

    /* One scan per symbol. Every exit policy is then re-simulated from the same
     * signals, so the comparison is apples-to-apples and costs one pass, not six. */
    const sc = B.scan(ctx, { bars: BARS, warmup: WARMUP, strictness: STRICT || undefined });
    if (!sc.ok) { console.log(sc.error); continue; }
    records.push(...sc.records.map(r => ({ ...r, symbol: sym })));
    totalBars += sc.records.length;

    const first = sc.bars1h[sc.records[0].idx], last = sc.bars1h[sc.bars1h.length - 1];
    totalBh.push((last.c - first.c) / first.c * 100);

    const gated = sc.records.filter(r => r.hasTrade && r.planRaw);
    const row = {
      symbol: sym, bars: sc.records.length,
      buyHoldPct: (last.c - first.c) / first.c * 100,
      trades: gated.length
    };

    for (const l of LADDERS) {
      const ladder = l.targets || gated.length && gated[0].planRaw.targets.map(t => ({ r: t.r, portion: t.portion }));
      const trades = [];
      gated.forEach(r => {
        const plan = {
          dir: r.planRaw.dir, stopDist: r.planRaw.stopDist, targets: ladder,
          composite: r.composite, confidence: r.confidence, tier: r.tier
        };
        const sim = B.simulate(sc.bars1h, r.idx + 1, plan, sc.opts);
        if (sim) trades.push(sim);
      });
      tradeSets[l.key].push(...trades);
      if (l.key === 'engine-default') {
        const st = B.stats(trades, sc.opts, sc.bars1h, sc.records[0].idx, sc.bars1h.length - 1);
        row.winRate = st.winRate; row.avgR = st.avgR; row.totalR = st.totalR;
        row.profitFactor = st.profitFactor; row.maxDrawdownPct = st.maxDrawdownPct;
        row.longShare = st.longs / Math.max(1, st.trades) * 100;
      }
    }

    /* blocker + composite reporting from the same scan */
    const bc = {};
    sc.records.forEach(r => r.blockers.forEach(b => { const k = b.code || 'OTHER'; bc[k] = (bc[k] || 0) + 1; }));
    row.blockerPct = Object.fromEntries(Object.entries(bc).map(([k, v]) => [k, v / Math.max(1, sc.records.length) * 100]));
    const absS = sc.records.map(r => Math.abs(r.composite)).sort((a, b) => a - b);
    const Ps = (a, q) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : 0;
    row.distribution = { p25: Ps(absS, .25), p50: Ps(absS, .5), p75: Ps(absS, .75), p90: Ps(absS, .9), max: absS.length ? absS[absS.length - 1] : 0 };

    perSymbol[sym] = row;
    console.log(`${sc.records.length} bars, ${gated.length} signals, avgR ${(row.avgR ?? 0).toFixed(3)}`);
  }

  const opts = { equity: 10000, riskPct: 1 };
  const ladderResults = LADDERS.map(l => ({
    key: l.key, label: l.label,
    stats: pooledStats(tradeSets[l.key], opts, totalBh)
  }));

  const blockers = {};
  records.forEach(r => r.blockers.forEach(b => { const k = b.code || 'OTHER'; blockers[k] = (blockers[k] || 0) + 1; }));
  const blockerPct = Object.fromEntries(Object.entries(blockers).map(([k, v]) => [k, v / Math.max(1, records.length) * 100]));

  const comps = records.map(r => r.composite).sort((a, b) => a - b);
  const abs = comps.map(Math.abs).sort((a, b) => a - b);
  const P = (arr, q) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : 0;

  const gated = records.filter(r => r.hasTrade).length;
  const setupRows = records.filter(r => r.hasSetup).length;

  const out = {
    generatedAt: new Date().toISOString(),
    engineVersion: E.VERSION,
    strictness: STRICT || E.DEFAULT_STRICTNESS,
      method: {
      symbols: SYMBOLS, barsPerSymbol: BARS, warmup: WARMUP,
      totalBarsEvaluated: totalBars,
      costs: B.DEFAULTS.feePct + '% taker per leg + ' + B.DEFAULTS.slipPct + '% slippage per leg',
      note: 'Walk-forward: signals use only closed bars at each step; higher timeframes truncated by close time. If a bar contains both stop and target, the stop is assumed to fill first.'
    },
    buyHoldMeanPct: I.mean(totalBh),
    gatedSignalPct: totalBars ? gated / totalBars * 100 : 0,
    blockerPct,
    distribution: {
      p10: P(abs, .1), p25: P(abs, .25), p50: P(abs, .5), p75: P(abs, .75), p90: P(abs, .9),
      max: abs.length ? abs[abs.length - 1] : 0
    },
    ladders: ladderResults,
    baseLadder: ladderResults[0].stats,
    perSymbol,
    limitations: [
      'Only factors that have history are active in the backtest: open-interest-vs-price, 15m taker aggression and order-book imbalance have no historical series on this venue and are switched off (their weight is redistributed).',
      'Funding cost of holding a position is not charged; only entry/exit fees and slippage are.',
      'Liquidation is not simulated — a stop-out is assumed to fill at the stop.',
      'Results are from a single market regime (the most recent ~' + Math.round(BARS / 24) + ' days on each symbol).'
    ]
  };

  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/calibration.json'), JSON.stringify(out, null, 2));

  console.log('\n=== POOLED, gated strategy (what the app actually emits)');
  console.log(`bars evaluated: ${totalBars}   gate-passed signals: ${gated} (${out.gatedSignalPct.toFixed(1)}%)   unfiltered setups: ${setupRows} (${(setupRows / Math.max(1, totalBars) * 100).toFixed(1)}%)`);
  console.log('\nexit policy                     trades  winRate    avgR   totalR     PF   maxDD    t-stat');
  ladderResults.forEach(l => {
    const s = l.stats;
    if (!s.trades) { console.log(`${l.label.padEnd(30)}      0`); return; }
    console.log(
      `${l.label.padEnd(30)}${String(s.trades).padStart(7)}` +
      `${s.winRate.toFixed(1).padStart(9)}%` +
      `${s.avgR.toFixed(3).padStart(8)}` +
      `${s.totalR.toFixed(1).padStart(9)}` +
      `${s.profitFactor.toFixed(2).padStart(7)}` +
      `${s.maxDrawdownPct.toFixed(1).padStart(8)}%` +
      `${s.tStatistic.toFixed(2).padStart(9)}`
    );
  });
  console.log('\n=== blocker frequency (% of evaluated bars)');
  Object.entries(blockerPct).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${v.toFixed(1).padStart(5)}%  ${k}`));
  console.log('\nwrote data/calibration.json');
})().catch(e => { console.error(e); process.exit(1); });
