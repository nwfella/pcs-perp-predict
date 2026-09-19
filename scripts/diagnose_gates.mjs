#!/usr/bin/env node
/* PCS-Perp-Predict — gate diagnosis.
 *
 * The engine gates a trade on six conditions. When every pair reads NO TRADE,
 * the useful question is not "which threshold feels too strict" but "where do
 * setups actually die, and what would each gate alone let through".
 *
 * For every pair this reports the verdict, the blocker tally, and a
 * counterfactual: the pass rate if each gate independently had not existed.
 * Counterfactuals are computed from the same blocker list, so they are exactly
 * the rows that gate alone rejected.
 *
 * Usage: node scripts/diagnose_gates.mjs [maxPairs] [symbolsCsv]
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const D = require(path.join(root, 'src/data.js'));
const E = require(path.join(root, 'src/engine.js'));
const I = require(path.join(root, 'src/indicators.js'));
const B = require(path.join(root, 'src/backtest.js'));

const MAX = parseInt(process.argv[2] || '40', 10);
const ONLY = process.argv[3] ? process.argv[3].split(',') : null;

(async () => {
  let symbols;
  if (ONLY) {
    symbols = ONLY;
  } else {
    const all = await D.pairs();
    /* majors first, then a spread of the rest, so the sample is representative
     * rather than 40 unknown microcaps */
    const ordered = D.sortForDropdown(all);
    const majors = ordered.slice(0, 8);
    const rest = ordered.slice(8).filter((_, i) => i % Math.max(1, Math.floor((ordered.length - 8) / (MAX - 8))) === 0);
    symbols = majors.concat(rest).slice(0, MAX).map((p) => p.symbol);
  }

  console.log(`scanning ${symbols.length} pairs…\n`);
  const rows = [];
  for (const sym of symbols) {
    let ctx;
    try { ctx = await D.loadContext(sym, { intervals: ['15m', '1h', '4h', '1d'] }); }
    catch (e) { console.log(`  ${sym} data fail`); continue; }
    const r = E.analyze(ctx, { interval: '1h', equity: 10000, riskPct: 1, leverage: 5 });
    if (!r.ok) { console.log(`  ${sym} ${r.error}`); continue; }
    rows.push({
      sym, verdict: r.verdict, tier: r.tier, composite: r.composite, agreement: r.agreement,
      coverage: r.coverage, atrPct: r.atrPct,
      vol24h: ctx.deriv.ticker ? parseFloat(ctx.deriv.ticker.quoteVolume) : null,
      codes: r.blockers.map((b) => b.code),
      attainableR: r.plan ? r.plan.attainableR : null,
      roomAtr: r.plan ? r.plan.roomAtr : null,
      stopPct: r.plan ? r.plan.stopPct : null,
      blockers: r.blockers
    });
    process.stdout.write('.');
  }
  console.log('\n');

  const n = rows.length;
  const cnt = (fn) => rows.filter(fn).length;
  const pct = (k) => `${(k / n * 100).toFixed(0)}%`.padStart(4);

  console.log(`=== verdicts across ${n} pairs`);
  ['LONG', 'SHORT', 'NO TRADE'].forEach((v) => {
    console.log(`  ${v.padEnd(9)} ${String(cnt((r) => r.verdict === v)).padStart(4)}  ${pct(cnt((r) => r.verdict === v))}`);
  });

  console.log('\n=== how many pairs were blocked by each gate (a pair can trip several)');
  const codes = {};
  rows.forEach((r) => r.codes.forEach((c) => { codes[c] = (codes[c] || 0) + 1; }));
  Object.entries(codes).sort((a, b) => b[1] - a[1]).forEach(([c, k]) => {
    console.log(`  ${c.padEnd(10)} ${String(k).padStart(4)}  ${pct(k)}   ${rows[0] ? (rows.find((r) => r.codes.includes(c)).blockers.find((b) => b.code === c).text.slice(0, 78)) : ''}`);
  });

  console.log('\n=== counterfactual: pass rate if that ONE gate were removed');
  const gates = ['BAND_MIN', 'AGREE', 'ROOM', 'VOL24H', 'COVERAGE', 'VOL_LOW', 'VOL_HIGH', 'LIQ'];
  gates.forEach((g) => {
    const k = cnt((r) => r.codes.filter((c) => c !== g).length === 0);
    if (k > 0) console.log(`  without ${g.padEnd(10)} ${String(k).padStart(4)} of ${n} would trade  ${pct(k)}`);
  });

  console.log('\n=== the two structural gates in detail');
  const withPlan = rows.filter((r) => r.roomAtr !== null && r.attainableR !== null);
  if (withPlan.length) {
    const ar = withPlan.map((r) => r.attainableR).sort((a, b) => a - b);
    const q = (p) => ar[Math.min(ar.length - 1, Math.floor(ar.length * p))];
    console.log(`  attainable R  min ${ar[0].toFixed(2)}  p25 ${q(.25).toFixed(2)}  p50 ${q(.5).toFixed(2)}  p75 ${q(.75).toFixed(2)}  max ${ar[ar.length - 1].toFixed(2)}`);
    console.log(`  pairs with attainableR >= 1.0 : ${withPlan.filter((r) => r.attainableR >= 1).length} / ${n}`);
    console.log(`  pairs with attainableR >= 1.5 : ${withPlan.filter((r) => r.attainableR >= 1.5).length} / ${n}`);
    console.log(`  pairs with attainableR >= 2.0 : ${withPlan.filter((r) => r.attainableR >= 2).length} / ${n}`);
    const room = withPlan.map((r) => r.roomAtr).sort((a, b) => a - b);
    const qr = (p) => room[Math.min(room.length - 1, Math.floor(room.length * p))];
    console.log(`  room to structure (ATR) p25 ${qr(.25).toFixed(2)}  p50 ${qr(.5).toFixed(2)}  p75 ${qr(.75).toFixed(2)}`);
    console.log(`  stop distance %  p25 ${withPlan.map((r) => r.stopPct).sort((a, b) => a - b)[Math.floor(withPlan.length * .25)].toFixed(2)}  p50 ${withPlan.map((r) => r.stopPct).sort((a, b) => a - b)[Math.floor(withPlan.length * .5)].toFixed(2)}`);
  }

  console.log('\n=== composite distribution');
  const abs = rows.map((r) => Math.abs(r.composite)).sort((a, b) => a - b);
  const qa = (p) => abs[Math.min(abs.length - 1, Math.floor(abs.length * p))];
  console.log(`  |composite|  p25 ${qa(.25).toFixed(1)}  p50 ${qa(.5).toFixed(1)}  p75 ${qa(.75).toFixed(1)}  p90 ${qa(.9).toFixed(1)}  max ${abs[abs.length - 1].toFixed(1)}`);
  [10, 12, 15, 18, 22].forEach((t) => {
    console.log(`  |composite| >= ${String(t).padStart(2)} : ${cnt((r) => Math.abs(r.composite) >= t)} / ${n}`);
  });

  console.log('\n=== agreement distribution');
  const ag = rows.map((r) => r.agreement).sort((a, b) => a - b);
  const qg = (p) => ag[Math.min(ag.length - 1, Math.floor(ag.length * p))];
  console.log(`  agreement  p25 ${qg(.25).toFixed(2)}  p50 ${qg(.5).toFixed(2)}  p75 ${qg(.75).toFixed(2)}`);
  [0.5, 0.55, 0.58, 0.62].forEach((t) => {
    console.log(`  agreement >= ${t.toFixed(2)} : ${cnt((r) => r.agreement >= t)} / ${n}`);
  });

  console.log('\n=== sample of the closest-to-firing pairs');
  rows.slice().sort((a, b) => a.codes.length - b.codes.length || Math.abs(b.composite) - Math.abs(a.composite))
    .slice(0, 8)
    .forEach((r) => {
      console.log(`  ${r.sym.padEnd(13)} comp ${String(r.composite).padStart(6)}  agr ${r.agreement.toFixed(2)}  attR ${r.attainableR === null ? '  n/a' : r.attainableR.toFixed(2)}  blocked by [${r.codes.join(',')}]`);
    });
})().catch((e) => { console.error(e); process.exit(1); });
