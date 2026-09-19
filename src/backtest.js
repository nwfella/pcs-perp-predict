/* PCS-Perp-Predict — backtester.
 *
 * Replays PPEngine.analyze bar by bar over historical klines, using only data
 * that existed at each bar's close, then simulates the plan the engine produced.
 *
 * Two deliberate biases, both on the pessimistic side:
 *  1. Higher timeframes are truncated by CLOSE time against the 1h bar being
 *     evaluated, so a still-forming 4h candle can never leak into the signal.
 *  2. If a bar's range contains both the stop and a target, the STOP is assumed
 *     to have filled first. Real fills are usually somewhere between the two.
 *
 * Costs are charged: taker fee on both legs plus slippage on both legs, all
 * converted into R using the trade's own stop distance.
 */
(function (root, factory) {
  var api = factory(
    (typeof module === 'object' && module.exports)
      ? { E: require('./engine.js'), I: require('./indicators.js') }
      : { E: (typeof globalThis !== 'undefined' ? globalThis.PPEngine : null), I: (typeof globalThis !== 'undefined' ? globalThis.PPIndicators : null) }
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PPBacktest = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (mods) {
  'use strict';

  var E = mods.E, I = mods.I;
  if (!E || !I) throw new Error('PPBacktest requires PPEngine and PPIndicators');

  var DEFAULTS = {
    bars: 400,          // how many 1h bars to evaluate signals on
    warmup: 300,        // bars consumed before the first signal
    maxHoldBars: 120,   // abandon a stalled trade after this many 1h bars
    equity: 10000,
    riskPct: 1,
    leverage: 5,
    feePct: 0.035,      // Aster taker, per leg
    slipPct: 0.02,      // assumed slippage, per leg
    useCosts: true
  };

  function rolling24hQuoteVolume(bars, i) {
    var s = 0, from = Math.max(0, i - 23);
    for (var j = from; j <= i; j++) s += bars[j].q;
    return s;
  }

  /* Highest-timeframe slicing that cannot see a partially formed candle. */
  function sliceTo(bars, closeTime) {
    if (!bars) return [];
    for (var i = bars.length - 1; i >= 0; i--) if (bars[i].ct <= closeTime) return bars.slice(0, i + 1);
    return [];
  }

  function fundingUpTo(hist, closeTime) {
    var out = [];
    if (!hist) return out;
    for (var i = 0; i < hist.length; i++) {
      var ft = Number(hist[i].fundingTime);
      if (ft <= closeTime) out.push(hist[i]); else break;
    }
    return out;
  }

  /* Simulate one plan forward. Returns the trade result in R. */
  function simulate(bars, entryIdx, plan, opts) {
    var dir = plan.dir, stopDist = plan.stopDist;
    var entry = bars[entryIdx].o;
    if (!entry || !stopDist) return null;
    var stop = entry - dir * stopDist;
    var targets = plan.targets.map(function (t) { return { r: t.r, price: entry + dir * stopDist * t.r, portion: t.portion, filled: false }; });
    var remaining = 1, realized = 0, beMoved = false, tpCount = 0;
    var last = Math.min(bars.length - 1, entryIdx + opts.maxHoldBars - 1);
    var exitIdx = last, exitReason = 'timeout', maes = 0;

    for (var j = entryIdx; j <= last; j++) {
      var b = bars[j];
      var adverse = dir > 0 ? (entry - b.l) / stopDist : (b.h - entry) / stopDist;
      if (adverse > maes) maes = adverse;

      /* stop first — the conservative assumption */
      var stopHit = dir > 0 ? b.l <= stop : b.h >= stop;
      if (stopHit) {
        realized += remaining * (dir * (stop - entry)) / stopDist;
        exitIdx = j; exitReason = tpCount ? 'stopped-after-partial' : 'stopped';
        remaining = 0;
        break;
      }
      for (var k = 0; k < targets.length; k++) {
        var t = targets[k];
        if (t.filled) continue;
        var hit = dir > 0 ? b.h >= t.price : b.l <= t.price;
        if (!hit) continue;
        realized += t.portion * t.r;
        remaining -= t.portion;
        t.filled = true; tpCount++;
        if (k === 0 && !beMoved) { stop = entry; beMoved = true; }
      }
      if (remaining <= 1e-9) { exitIdx = j; exitReason = 'target'; break; }
    }

    if (remaining > 1e-9) {
      var ex = bars[exitIdx].c;
      realized += remaining * (dir * (ex - entry)) / stopDist;
      if (exitReason === 'timeout') exitReason = 'timeout';
    }

    var stopPct = stopDist / entry * 100;
    var costR = opts.useCosts ? ((2 * opts.feePct + 2 * opts.slipPct) / stopPct) : 0;
    var gross = realized;
    var net = realized - costR;
    return {
      entryIdx: entryIdx, exitIdx: exitIdx, barsHeld: exitIdx - entryIdx + 1,
      side: dir > 0 ? 'LONG' : 'SHORT', entry: entry, stop: entry - dir * stopDist,
      stopPct: stopPct, grossR: gross, costR: costR, netR: net,
      exitReason: exitReason, targetsFilled: tpCount, maeR: maes,
      composite: plan.composite, confidence: plan.confidence, tier: plan.tier
    };
  }

  /* Extract the plan-shaped object `simulate` needs from an analyze() result.
   * `opts.targets` overrides the engine's R ladder so exit policies can be
   * compared against each other on the same signals. */
  function planFrom(res, opts) {
    if (!res.plan) return null;
    var ladder = (opts && opts.targets) ? opts.targets : res.plan.targets.map(function (t) {
      return { r: t.r, portion: t.portion };
    });
    return {
      dir: res.plan.dir, stopDist: res.plan.stopDist,
      targets: ladder,
      composite: res.composite, confidence: res.confidence, tier: res.tier
    };
  }

  /* Walk-forward signal scan. Returns per-signal records; used both for the
   * statistics and for calibrating the no-trade thresholds. */
  function scan(ctx, opts) {
    var o = Object.assign({}, DEFAULTS, opts || {});
    var bars1h = ctx.bars['1h'];
    if (!bars1h || bars1h.length < o.warmup + 20) {
      return { ok: false, error: 'Need ' + (o.warmup + 20) + ' hourly bars, have ' + (bars1h ? bars1h.length : 0) + '.' };
    }
    var start = Math.max(o.warmup, bars1h.length - o.bars - 1);
    var records = [];

    for (var i = start; i < bars1h.length - 1; i++) {
      var cut = bars1h[i].ct;
      var sub = {
        symbol: ctx.symbol,
        bars: {
          '1h': bars1h.slice(0, i + 1),
          '4h': sliceTo(ctx.bars['4h'], cut),
          '1d': sliceTo(ctx.bars['1d'], cut)
        },
        deriv: {
          ticker: { quoteVolume: rolling24hQuoteVolume(bars1h, i), lastPrice: bars1h[i].c },
          lastFundingRate: null,
          depth: null
        },
        fundingHist: fundingUpTo(ctx.fundingHist, cut),
        oiHist: null
      };
      /* lastFundingRate is derived inside the engine from the history slice, so
       * passing null here is correct — it will use the newest closed interval. */
      var res = E.analyze(sub, Object.assign({}, o, { interval: '1h' }));
      if (!res.ok) continue;
      records.push({
        idx: i, ts: bars1h[i].t, composite: res.composite, confidence: res.confidence,
        agreement: res.agreement, coverage: res.coverage, verdict: res.verdict,
        tier: res.tier, blockers: res.blockers, plan: planFrom(res, o), atrPct: res.atrPct,
        planRaw: res.plan
      });
    }
    return { ok: true, records: records, bars1h: bars1h, opts: o };
  }

  function stats(trades, opts, bars1h, fromIdx, toIdx) {
    var n = trades.length;
    var wins = trades.filter(function (t) { return t.netR > 0; });
    var losses = trades.filter(function (t) { return t.netR <= 0; });
    var grossWin = I.sum(wins.map(function (t) { return t.netR; }));
    var grossLoss = Math.abs(I.sum(losses.map(function (t) { return t.netR; })));
    var avgR = n ? I.sum(trades.map(function (t) { return t.netR; })) / n : 0;

    var equity = opts.equity, peak = equity, maxDD = 0, curve = [{ i: 0, equity: equity }];
    var streak = 0, worstStreak = 0;
    trades.forEach(function (t, idx) {
      equity *= (1 + t.netR * opts.riskPct / 100);
      curve.push({ i: idx + 1, equity: equity });
      if (equity > peak) peak = equity;
      var dd = peak > 0 ? (peak - equity) / peak * 100 : 0;
      if (dd > maxDD) maxDD = dd;
      if (t.netR <= 0) { streak++; if (streak > worstStreak) worstStreak = streak; } else streak = 0;
    });

    var first = bars1h[fromIdx], last = bars1h[toIdx];
    var buyHold = first && last ? (last.c - first.c) / first.c * 100 : 0;

    return {
      trades: n,
      wins: wins.length, losses: losses.length,
      winRate: n ? wins.length / n * 100 : 0,
      avgR: avgR,
      expectancyR: avgR,
      totalR: I.sum(trades.map(function (t) { return t.netR; })),
      grossWinR: grossWin, grossLossR: grossLoss,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
      avgWinR: wins.length ? I.sum(wins.map(function (t) { return t.netR; })) / wins.length : 0,
      avgLossR: losses.length ? I.sum(losses.map(function (t) { return t.netR; })) / losses.length : 0,
      maxDrawdownPct: maxDD,
      worstLosingStreak: worstStreak,
      avgBarsHeld: n ? I.sum(trades.map(function (t) { return t.barsHeld; })) / n : 0,
      avgCostR: n ? I.sum(trades.map(function (t) { return t.costR; })) / n : 0,
      finalEquity: equity,
      equityCurve: curve,
      buyHoldPct: buyHold,
      longs: trades.filter(function (t) { return t.side === 'LONG'; }).length,
      shorts: trades.filter(function (t) { return t.side === 'SHORT'; }).length,
      byReason: trades.reduce(function (a, t) { a[t.exitReason] = (a[t.exitReason] || 0) + 1; return a; }, {})
    };
  }

  function run(ctx, opts) {
    var s = scan(ctx, opts);
    if (!s.ok) return s;
    var o = s.opts, bars1h = s.bars1h;
    var trades = [];
    var taken = [];
    s.records.forEach(function (r) {
      if (r.verdict === 'NO TRADE' || !r.plan) return;
      var sim = simulate(bars1h, r.idx + 1, r.plan, o);
      if (sim) { sim.signalAt = r.ts; trades.push(sim); taken.push(r); }
    });

    var fromIdx = s.records.length ? s.records[0].idx : 0;
    var toIdx = bars1h.length - 1;

    /* Blocker frequency: what is actually stopping the model most often. */
    var blockerCounts = {};
    s.records.forEach(function (r) {
      r.blockers.forEach(function (b) {
        var key = b.code || String(b).slice(0, 24);
        blockerCounts[key] = (blockerCounts[key] || 0) + 1;
      });
    });

    var comps = s.records.map(function (r) { return r.composite; }).sort(function (a, b) { return a - b; });
    var pct = function (p) { return comps.length ? comps[Math.min(comps.length - 1, Math.floor(comps.length * p))] : 0; };

    return {
      ok: true,
      trades: trades,
      stats: stats(trades, o, bars1h, fromIdx, toIdx),
      signalCount: s.records.length,
      barsEvaluated: s.records.length,
      signals: s.records.map(function (r) {
        return { ts: r.ts, composite: r.composite, confidence: r.confidence, agreement: r.agreement, verdict: r.verdict, tier: r.tier };
      }),
      blockerCounts: blockerCounts,
      compositeDistribution: {
        min: comps.length ? comps[0] : 0, max: comps.length ? comps[comps.length - 1] : 0,
        p10: pct(0.10), p25: pct(0.25), p50: pct(0.50), p75: pct(0.75), p90: pct(0.90),
        absP50: comps.length ? Math.abs(comps[Math.floor(comps.length / 2)]) : 0,
        absP75: Math.abs(pct(0.75)), absP25: Math.abs(pct(0.25)),
        pctAbove22: comps.length ? comps.filter(function (c) { return Math.abs(c) >= 22; }).length / comps.length * 100 : 0,
        pctAbove15: comps.length ? comps.filter(function (c) { return Math.abs(c) >= 15; }).length / comps.length * 100 : 0,
        pctAbove30: comps.length ? comps.filter(function (c) { return Math.abs(c) >= 30; }).length / comps.length * 100 : 0
      },
      gapFraction: s.records.length ? (s.records.length - taken.length) / s.records.length : 0,
      opts: o
    };
  }

  /* Sweep a threshold so the gate can be set from measured signal frequency
   * rather than picked out of the air. */
  function calibrate(ctx, opts, thresholds) {
    var s = scan(ctx, opts);
    if (!s.ok) return s;
    var o = s.opts, bars1h = s.bars1h;
    var minAg = o.minAgreement !== undefined ? o.minAgreement : E.CFG.minAgreement;
    thresholds = thresholds || [10, 12, 15, 18, 20, 22, 25, 30, 35, 40];
    var rows = thresholds.map(function (th) {
      var trades = [];
      s.records.forEach(function (r) {
        if (!r.plan) return;
        if (Math.abs(r.composite) < th) return;
        if (r.agreement < minAg) return;
        var sim = simulate(bars1h, r.idx + 1, r.plan, o);
        if (sim) trades.push(sim);
      });
      var st = stats(trades, o, bars1h, s.records.length ? s.records[0].idx : 0, bars1h.length - 1);
      return {
        threshold: th, trades: st.trades, winRate: st.winRate, avgR: st.avgR,
        totalR: st.totalR, profitFactor: st.profitFactor, maxDrawdownPct: st.maxDrawdownPct,
        finalEquity: st.finalEquity, signalPct: s.records.length ? st.trades / s.records.length * 100 : 0,
        buyHoldPct: st.buyHoldPct
      };
    });
    var best = rows.filter(function (r) { return r.trades >= 5; })
      .sort(function (a, b) { return b.avgR - a.avgR; })[0] || null;
    return { ok: true, rows: rows, best: best, distribution: null };
  }

  return { DEFAULTS: DEFAULTS, run: run, scan: scan, calibrate: calibrate, stats: stats, simulate: simulate };
});
