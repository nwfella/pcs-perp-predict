/* PCS-Perp-Predict — analysis engine.
 *
 * Deterministic, transparent, DOM-free. 22 weighted factors in 6 groups, each
 * emitting a score in [-1, +1] (negative = short bias) plus the numbers behind
 * it. The composite is 100 * sum(score_i * weight_i) with weights renormalised
 * over whichever factors actually had data.
 *
 * Deliberately rule-based rather than a black box: every point of the score can
 * be traced to a named reading, and the backtester runs this exact code.
 */
(function (root, factory) {
  var api = factory(
    (typeof module === 'object' && module.exports)
      ? require('./indicators.js')
      : (typeof globalThis !== 'undefined' ? globalThis.PPIndicators : null)
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PPEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (I) {
  'use strict';

  if (!I) throw new Error('PPEngine requires PPIndicators to be loaded first');

  var VERSION = '1.0.0';

  /* ---------------------------------------------------------------- groups */

  var GROUPS = [
    { id: 'A', name: 'Trend',                weight: 0.26, blurb: 'Direction and persistence of the move' },
    { id: 'B', name: 'Momentum',             weight: 0.20, blurb: 'Speed of price change and exhaustion' },
    { id: 'C', name: 'Volatility & regime',  weight: 0.12, blurb: 'Breakout vs mean-reversion context' },
    { id: 'D', name: 'Volume & flow',        weight: 0.16, blurb: 'Real taker flow, not close-to-close guesses' },
    { id: 'E', name: 'Derivatives context',  weight: 0.16, blurb: 'What the perp crowd is positioned for' },
    { id: 'F', name: 'Levels & liquidity',   weight: 0.10, blurb: 'Room to run and stop-hunt behaviour' }
  ];

  /* ------------------------------------------------------------- thresholds */

  var CFG = {
    minComposite: 15,      // |composite| below this => NO TRADE
    minAgreement: 0.58,    // weighted share of factors backing the verdict
    minVolume24h: 1e6,     // USD quote volume floor
    minAtrPct: 0.05,       // dead market guard
    maxAtrPct: 15,         // unhinged market guard
    /* "Not boxed in" check, NOT a demand for clear air. Structure between entry
     * and target is a magnet the trend is expected to break, so requiring 2R of
     * pristine space before the next swing is unsatisfiable: the measured median
     * attainable room on 1h is 0.88R, which made this gate reject 72% of pairs
     * on its own. Only refuse when price is pinned against structure closer than
     * half a stop. */
    minAttainableR: 0.5,
    leanThreshold: 8,      // |composite| below this reads as NEUTRAL
    roomRR: 1.5,           // reward:risk the stop must leave room for
    minStopAtrMult: 0.6,   // never tighten the stop below this many ATR
    atrStopMult: 1.5,
    stopFloorPct: 0.35,
    stopCeilPct: 6.0,
    targets: [
      { r: 1.5, portion: 0.40 },
      { r: 3.0, portion: 0.35 },
      { r: 5.0, portion: 0.25 }
    ]
  };

  /* Selectable strictness. The loosest setting exists because a tool that says
   * NO TRADE on every pair carries no information; the strictest exists because
   * none of these profiles has a demonstrated edge, so selectivity is a
   * legitimate choice. Which one you run is yours — what measured what is shown
   * either way. */
  var STRICTNESS = {
    conservative: { minComposite: 22, minAgreement: 0.62, minAttainableR: 1.0 },
    balanced:     { minComposite: 15, minAgreement: 0.58, minAttainableR: 0.5 },
    aggressive:   { minComposite: 10, minAgreement: 0.52, minAttainableR: 0.25 }
  };
  var DEFAULT_STRICTNESS = 'balanced';

  function thresholdSet(strictness) {
    var s = STRICTNESS[strictness] || STRICTNESS[DEFAULT_STRICTNESS];
    return {
      minComposite: s.minComposite,
      minAgreement: s.minAgreement,
      minAttainableR: s.minAttainableR,
      minVolume24h: CFG.minVolume24h,
      minAtrPct: CFG.minAtrPct,
      maxAtrPct: CFG.maxAtrPct
    };
  }

  /* Directional read, always available, independent of whether the gates let a
   * plan through. A NO TRADE verdict should still tell you which way the
   * evidence leans instead of saying nothing. */
  function leanOf(composite) {
    if (composite >= CFG.leanThreshold) return { lean: 'LONG', sign: 1 };
    if (composite <= -CFG.leanThreshold) return { lean: 'SHORT', sign: -1 };
    return { lean: 'NEUTRAL', sign: 0 };
  }

  function sign(x) { return x > 0 ? 1 : x < 0 ? -1 : 0; }
  function lastN(a, n) { return a.slice(Math.max(0, a.length - n)); }

  /* ------------------------------------------------------------- prep work */

  /* Build every derived series once per timeframe. */
  function prep(bars) {
    var c = I.cols(bars, 'c'), h = I.cols(bars, 'h'), l = I.cols(bars, 'l'), v = I.cols(bars, 'v');
    return {
      bars: bars, n: bars.length, c: c, h: h, l: l, v: v,
      ema9: I.ema(c, 9), ema20: I.ema(c, 20), ema50: I.ema(c, 50), ema200: I.ema(c, 200),
      rsi14: I.rsi(c, 14),
      macd: I.macd(c, 12, 26, 9),
      atr14: I.atr(h, l, c, 14),
      adx: I.adx(h, l, c, 14),
      bb: I.bollinger(c, 20, 2),
      stoch: I.stochastic(h, l, c, 14, 3, 3),
      obv: I.obv(c, v),
      vwap20: I.vwap(h, l, c, v, 20),
      don: I.donchian(h, l, 20),
      sw: I.swings(h, l, 2),
      delta: I.deltaVolume(bars),
      cd: null, cdN: null
    };
  }

  function withCumDelta(p) {
    p.cd = I.cumsum(p.delta);
    var absSum = 0;
    for (var i = 0; i < p.delta.length; i++) absSum += Math.abs(p.delta[i]);
    p.cdN = absSum ? p.cd.map(function (x) { return x / absSum; }) : p.cd.map(function () { return 0; });
    return p;
  }

  function atrPctOf(p, i) {
    var a = p.atr14[i];
    return a === null ? null : a / p.c[i] * 100;
  }

  /* ------------------------------------------------------------- factor maker */

  function factor(id, group, name, weight, score, detail, evidence, available) {
    var s = available === false ? 0 : I.clamp(score, -1, 1);
    return {
      id: id, group: group, name: name, weight: weight,
      score: Math.round(s * 1000) / 1000,
      detail: detail, evidence: evidence || {},
      available: available !== false
    };
  }

  function unavailable(id, group, name, weight, why) {
    return factor(id, group, name, weight, 0, why, {}, false);
  }

  /* --------------------------------------------------------------- factors */

  /* EMA stack alignment: how much of the classic 20/50/200 ordering holds, plus
   * the direction the 50 EMA is actually travelling. */
  function emaStackFactor(p, id, group, name, weight, tf) {
    var i = p.n - 1, c = p.c[i], e20 = p.ema20[i], e50 = p.ema50[i], e200 = p.ema200[i];
    if (e20 === null || e50 === null || e200 === null) return unavailable(id, group, name, weight, 'Not enough bars for EMA200 on ' + tf);
    var stack = 0;
    stack += c > e20 ? 1 : -1;
    stack += e20 > e50 ? 1 : -1;
    stack += e50 > e200 ? 1 : -1;
    var base = stack / 3;
    var slope = I.normSlope(p.ema50, 20);
    var slopeTilt = slope === null ? 0 : I.clamp(slope * 60, -1, 1);
    var score = I.clamp(base * 0.75 + slopeTilt * 0.25 * Math.abs(base || 1), -1, 1);
    return factor(id, group, name, weight, score,
      (base > 0 ? 'Bullish' : base < 0 ? 'Bearish' : 'Mixed') + ' EMA stack on ' + tf +
      '; 50EMA ' + (slopeTilt > 0.05 ? 'rising' : slopeTilt < -0.05 ? 'falling' : 'flat') + '.',
      { close: c, ema20: e20, ema50: e50, ema200: e200, stack: stack, ema50Slope: slope });
  }

  /* ADX/DMI: directional pressure scaled by how trending the market is. */
  function adxFactor(p, id, group, name, weight, tf) {
    var i = p.n - 1;
    var a = p.adx.adx[i], pd = p.adx.plusDI[i], md = p.adx.minusDI[i];
    if (a === null || pd === null || md === null) return unavailable(id, group, name, weight, 'ADX warm-up incomplete on ' + tf);
    var denom = pd + md;
    var dir = denom ? (pd - md) / denom : 0;
    var strength = Math.min(1, a / 40);
    var score = dir * strength;
    if (a < 15) score *= 0.4;
    return factor(id, group, name, weight, score,
      'ADX ' + a.toFixed(1) + ' (' + (a >= 25 ? 'trending' : a >= 15 ? 'developing' : 'range') + '), ' +
      'DI+ ' + pd.toFixed(1) + ' vs DI- ' + md.toFixed(1) + ' on ' + tf + '.',
      { adx: a, plusDI: pd, minusDI: md, direction: dir, strength: strength });
  }

  /* Market structure from confirmed swing points, plus break-of-structure. */
  function structureFactor(p, id, group, name, weight, tf) {
    var hi = p.sw.highs, lo = p.sw.lows;
    if (hi.length < 2 || lo.length < 2) return unavailable(id, group, name, weight, 'Too few swing points on ' + tf);
    var h1 = hi[hi.length - 1], h0 = hi[hi.length - 2];
    var l1 = lo[lo.length - 1], l0 = lo[lo.length - 2];
    var hh = h1.price > h0.price, hl = l1.price > l0.price;
    var trend = (hh && hl) ? 1 : (!hh && !hl) ? -1 : 0;
    // break of structure: latest close vs the most recent swing level
    var c = p.c[p.n - 1];
    var brk = 0;
    if (c > h1.price) brk = 0.5;
    else if (c < l1.price) brk = -0.5;
    var score = I.clamp(trend + brk, -1, 1);
    var label = trend > 0 ? 'Higher highs + higher lows'
      : trend < 0 ? 'Lower highs + lower lows' : 'No clean structure (range)';
    return factor(id, group, name, weight, score,
      label + ' on ' + tf + (brk > 0 ? '; close has broken the last swing high.' : brk < 0 ? '; close has broken the last swing low.' : '.'),
      { lastSwingHigh: h1.price, prevSwingHigh: h0.price, lastSwingLow: l1.price, prevSwingLow: l0.price, break: brk });
  }

  /* Where price sits inside its 20-bar channel — trend continuation proxy. */
  function donchianFactor(p, id, group, name, weight, tf) {
    var pos = p.don.pos[p.n - 1];
    if (pos === null || pos === undefined) return unavailable(id, group, name, weight, 'Donchian warm-up incomplete on ' + tf);
    var score = I.scale(pos, 0.15, 0.85);
    return factor(id, group, name, weight, score,
      'Price at ' + (pos * 100).toFixed(0) + '% of the 20-bar ' + tf + ' channel.',
      { pos: pos, upper: p.don.upper[p.n - 1], lower: p.don.lower[p.n - 1] });
  }

  /* RSI: momentum through the middle, mean-reversion pressure at the tails. */
  function rsiFactor(p, id, group, name, weight, tf) {
    var i = p.n - 1, r = p.rsi14[i];
    if (r === null) return unavailable(id, group, name, weight, 'RSI warm-up incomplete on ' + tf);
    var base = I.scale(r, 35, 65);
    if (r > 72) base -= (r - 72) / 28 * 0.6;
    if (r < 28) base += (28 - r) / 28 * 0.6;
    var slope = I.normSlope(p.rsi14, 5);
    var tilt = slope === null ? 0 : I.clamp(slope * 4, -1, 1);
    var score = I.clamp(base * 0.75 + tilt * 0.25, -1, 1);
    return factor(id, group, name, weight, score,
      'RSI(14) ' + r.toFixed(1) + ' — ' +
      (r > 75 ? 'overbought, fade risk' : r > 60 ? 'strong' : r > 45 ? 'neutral' : r > 30 ? 'weak' : r > 25 ? 'oversold' : 'deeply oversold, bounce risk') +
      ' on ' + tf + '.',
      { rsi: r, slope: slope });
  }

  /* Classic divergence: price makes a new extreme, RSI refuses to. */
  function divergenceFactor(p, id, group, name, weight, tf) {
    var hi = p.sw.highs, lo = p.sw.lows, r = p.rsi14;
    if (hi.length < 2 || lo.length < 2) return unavailable(id, group, name, weight, 'Too few swings to test divergence on ' + tf);
    var hit = hi[hi.length - 1], hip = hi[hi.length - 2];
    var lot = lo[lo.length - 1], lop = lo[lo.length - 2];
    var score = 0, kind = 'No divergence';
    var rh1 = r[hit.i], rh0 = r[hip.i], rl1 = r[lot.i], rl0 = r[lop.i];
    if (rh1 !== null && rh0 !== null && hit.price > hip.price && rh1 < rh0) {
      score = -I.clamp(Math.abs(rh0 - rh1) / 10, 0.2, 1);
      kind = 'Bearish divergence (price higher high, RSI lower high)';
    } else if (rl1 !== null && rl0 !== null && lot.price < lop.price && rl1 > rl0) {
      score = I.clamp(Math.abs(rl1 - rl0) / 10, 0.2, 1);
      kind = 'Bullish divergence (price lower low, RSI higher low)';
    }
    return factor(id, group, name, weight, score, kind + ' on ' + tf + '.',
      { priceHigh1: hit.price, priceHigh0: hip.price, rsiHigh1: rh1, rsiHigh0: rh0, priceLow1: lot.price, priceLow0: lop.price, rsiLow1: rl1, rsiLow0: rl0 });
  }

  /* MACD histogram, scaled by ATR so it is comparable across instruments. */
  function macdFactor(p, id, group, name, weight, tf) {
    var i = p.n - 1, h = p.macd.hist[i], a = p.atr14[i];
    if (h === null || !a) return unavailable(id, group, name, weight, 'MACD warm-up incomplete on ' + tf);
    var rel = h / a;
    var h3 = p.macd.hist[i - 3];
    var slopeRel = (h3 === null || h3 === undefined) ? 0 : (h - h3) / a;
    var score = I.clamp(I.softScale(rel, -0.6, 0.6) * 0.7 + I.softScale(slopeRel, -0.2, 0.2) * 0.3, -1, 1);
    return factor(id, group, name, weight, score,
      'MACD histogram ' + h.toFixed(4) + ' (' + (h > 0 ? 'above' : 'below') + ' signal, ' +
      (slopeRel > 0 ? 'rising' : slopeRel < 0 ? 'falling' : 'flat') + ') on ' + tf + '.',
      { hist: h, signal: p.macd.signal[i], macd: p.macd.macd[i], histRelAtr: rel, slopeRelAtr: slopeRel });
  }

  /* Momentum normalised by volatility — how far the move is in ATR terms. */
  function rocFactor(p, id, group, name, weight, tf) {
    var i = p.n - 1, back = 10;
    if (i < back) return unavailable(id, group, name, weight, 'Not enough bars on ' + tf);
    var atrPct = atrPctOf(p, i);
    if (!atrPct) return unavailable(id, group, name, weight, 'ATR unavailable on ' + tf);
    var roc = (p.c[i] - p.c[i - back]) / p.c[i - back] * 100;
    var ratio = roc / (atrPct * Math.sqrt(back));
    return factor(id, group, name, weight, I.softScale(ratio, -2.5, 2.5),
      back + '-bar change ' + roc.toFixed(2) + '% = ' + ratio.toFixed(2) + ' ATR-units on ' + tf + '.',
      { rocPct: roc, atrPct: atrPct, ratio: ratio });
  }

  /* Volatility-confirmed channel breakout. */
  function breakoutFactor(p, id, group, name, weight, tf) {
    var i = p.n - 1;
    if (i < 22) return unavailable(id, group, name, weight, 'Not enough bars on ' + tf);
    var aPct = atrPctOf(p, i);
    if (!aPct) return unavailable(id, group, name, weight, 'ATR unavailable on ' + tf);
    var hist = [];
    for (var j = Math.max(1, i - 20); j <= i; j++) { var v = atrPctOf(p, j); if (v) hist.push(v); }
    var avg = I.mean(hist);
    var expansion = avg ? aPct / avg : 1;
    var c = p.c[i], up = p.don.upper[i - 1], dn = p.don.lower[i - 1];
    var brk = 0;
    if (up !== null && c > up) brk = 1;
    else if (dn !== null && c < dn) brk = -1;
    if (!brk) {
      return factor(id, group, name, weight, 0,
        'No 20-bar channel break on ' + tf + '; volatility ' + expansion.toFixed(2) + 'x its 20-bar average.',
        { expansion: expansion, atrPct: aPct, break: 0 });
    }
    var conf = I.clamp(expansion - 0.8, 0, 1.2) / 1.2;
    return factor(id, group, name, weight, brk * conf,
      (brk > 0 ? 'Upside' : 'Downside') + ' 20-bar channel break on ' + tf +
      ', volatility ' + expansion.toFixed(2) + 'x average (' + (conf > 0.5 ? 'confirmed' : 'weak confirmation') + ').',
      { expansion: expansion, atrPct: aPct, break: brk, channelUpper: up, channelLower: dn });
  }

  /* Stretch away from the mean: fades statistically extended moves. */
  function stretchFactor(p, id, group, name, weight, tf) {
    var i = p.n - 1, z = p.bb.z[i];
    if (z === null) return unavailable(id, group, name, weight, 'Bollinger warm-up incomplete on ' + tf);
    var score = -I.softScale(z, -2.2, 2.2);
    return factor(id, group, name, weight, score,
      'Price is ' + z.toFixed(2) + ' std devs from the 20-bar mean on ' + tf + '.' +
      (Math.abs(z) > 2 ? ' Statistically stretched — mean-reversion pressure.' : ''),
      { z: z, mid: p.bb.mid[i], upper: p.bb.upper[i], lower: p.bb.lower[i], widthPct: p.bb.width[i] });
  }

  /* Lag-1 return autocorrelation: is this market trending or chopping? */
  function autocorrFactor(p, id, group, name, weight, tf) {
    var i = p.n - 1, look = 60;
    if (i < look + 2) return unavailable(id, group, name, weight, 'Not enough bars on ' + tf);
    var rets = [];
    for (var j = i - look; j <= i; j++) rets.push((p.c[j] - p.c[j - 1]) / p.c[j - 1]);
    var a = rets.slice(1), b = rets.slice(0, rets.length - 1);
    var ac = I.corr(a, b);
    var dir = sign(p.c[i] - p.c[i - 10]);
    var score = I.clamp(ac * dir * 3, -1, 1);
    return factor(id, group, name, weight, score,
      'Return autocorrelation ' + ac.toFixed(3) + ' over ' + look + ' bars on ' + tf + ' — ' +
      (ac > 0.08 ? 'trend-persistent, follows through' : ac < -0.08 ? 'mean-reverting, fades' : 'no persistence') + '.',
      { autocorr: ac, direction: dir });
  }

  /* Relative volume, directionally weighted by the candle body. */
  function relVolFactor(p, id, group, name, weight, tf) {
    var i = p.n - 1;
    if (i < 21) return unavailable(id, group, name, weight, 'Not enough bars on ' + tf);
    var win = p.v.slice(i - 20, i);
    var avg = I.mean(win);
    if (!avg) return unavailable(id, group, name, weight, 'Zero average volume on ' + tf);
    var rvol = p.v[i] / avg;
    var rng = p.h[i] - p.l[i];
    var bar = p.bars[i];
    var body = rng ? (bar.c - bar.o) / rng : 0;
    /* Volume is conviction, not direction: a quiet bar is a weak signal in
     * whichever direction the body points, so conviction floors at 0 instead of
     * flipping the sign and voting short on low volume. */
    var conviction = I.clamp((rvol - 0.6) / 1.4, 0, 1);
    var score = conviction * I.clamp(body * 2, -1, 1);
    return factor(id, group, name, weight, score,
      'Volume ' + rvol.toFixed(2) + 'x its 20-bar average, candle body ' + (body * 100).toFixed(0) + '% of range on ' + tf + '.',
      { relativeVolume: rvol, bodyFrac: body, avgVolume: avg, volume: p.v[i] });
  }

  /* Cumulative taker delta — real aggressor flow from the exchange's own
   * taker-buy field, not inferred from candle direction. */
  function deltaFactor(p, id, group, name, weight, tf) {
    if (!p.cdN) return unavailable(id, group, name, weight, 'No taker-flow data on ' + tf);
    var i = p.n - 1;
    if (i < 25) return unavailable(id, group, name, weight, 'Not enough bars on ' + tf);
    var slope = I.normSlope(p.cdN, 20);
    if (slope === null) return unavailable(id, group, name, weight, 'Flow slope unavailable on ' + tf);
    var score = I.clamp(I.softScale(slope * 40, -1, 1), -1, 1);
    var net = 0;
    for (var j = i - 19; j <= i; j++) net += p.delta[j];
    var gross = 0;
    for (var k = i - 19; k <= i; k++) gross += Math.abs(p.delta[k]);
    var skew = gross ? net / gross : 0;
    return factor(id, group, name, weight, score,
      'Taker flow over 20 bars is ' + (skew > 0 ? 'buy' : 'sell') + '-skewed at ' + (skew * 100).toFixed(1) +
      '% of gross on ' + tf + '.',
      { netDelta: net, grossDelta: gross, skew: skew, slope: slope });
  }

  /* OBV trend and its divergence against price. */
  function obvFactor(p, id, group, name, weight, tf) {
    var i = p.n - 1;
    if (i < 25) return unavailable(id, group, name, weight, 'Not enough bars on ' + tf);
    var total = I.sum(p.v.slice(Math.max(0, i - 20), i + 1)) || 1;
    var scaled = p.obv.slice(Math.max(0, i - 40), i + 1).map(function (x) { return x / total; });
    var slope = I.normSlope(scaled, 20);
    if (slope === null) return unavailable(id, group, name, weight, 'OBV slope unavailable on ' + tf);
    var score = I.clamp(I.softScale(slope * 6, -1, 1), -1, 1);
    var priceDir = sign(p.c[i] - p.c[i - 10]);
    var obvDir = sign(I.lastValid(scaled) - scaled[0]);
    var div = (priceDir !== 0 && obvDir !== 0 && priceDir !== obvDir) ? -0.35 * priceDir : 0;
    score = I.clamp(score + div, -1, 1);
    return factor(id, group, name, weight, score,
      'OBV ' + (obvDir > 0 ? 'accumulating' : obvDir < 0 ? 'distributing' : 'flat') + ' on ' + tf +
      (div ? '; diverging from price — distribution/accumulation mismatch.' : '.'),
      { slope: slope, priceDir: priceDir, obvDir: obvDir, divergencePenalty: div });
  }

  /* Which side of the 20-bar VWAP price is on, in ATR units. */
  function vwapFactor(p, id, group, name, weight, tf) {
    var i = p.n - 1, vw = p.vwap20[i], a = p.atr14[i];
    if (vw === null || !a) return unavailable(id, group, name, weight, 'VWAP warm-up incomplete on ' + tf);
    var dist = (p.c[i] - vw) / a;
    return factor(id, group, name, weight, I.softScale(dist, -2.5, 2.5),
      'Price is ' + dist.toFixed(2) + ' ATR ' + (dist > 0 ? 'above' : 'below') + ' the 20-bar VWAP on ' + tf + '.',
      { vwap: vw, distanceAtr: dist, close: p.c[i] });
  }

  /* Funding rate percentile — the crowd-positioning proxy on this venue. */
  function fundingFactor(ctx) {
    var id = 'E1', group = 'E', name = 'Funding rate positioning', weight = 0.06;
    var d = ctx.deriv || {};
    var hist = (ctx.fundingHist || []).map(function (x) { return parseFloat(x.fundingRate); });
    var lf = d.lastFundingRate !== undefined && d.lastFundingRate !== null ? parseFloat(d.lastFundingRate) : I.lastValid(hist);
    if (lf === null || lf === undefined || isNaN(lf)) return unavailable(id, group, name, weight, 'No funding data');
    var series = hist.length >= 5 ? hist : [lf];
    var p = I.percentileRank(series);
    if (p === null) return unavailable(id, group, name, weight, 'Not enough funding history');
    var raw = I.softScale(p, 1.0, 0.0);            // high funding => short bias
    var flatten = Math.min(1, Math.abs(p - 0.5) * 2.5); // dead zone in the middle
    var score = raw * flatten;
    var annual = lf * 3 * 365 * 100;
    return factor(id, group, name, weight, score,
      'Funding ' + (lf * 100).toFixed(4) + '% per 8h (' + annual.toFixed(1) + '% annualised), at the ' +
      (p * 100).toFixed(0) + 'th percentile of the last ' + series.length + ' intervals — ' +
      (p > 0.8 ? 'longs are crowded and paying, squeeze fuel' : p < 0.2 ? 'shorts are crowded and paying, squeeze fuel' : 'positioning is balanced') + '.',
      { fundingRate: lf, annualisedPct: annual, percentile: p, samples: series.length });
  }

  /* Open-interest change against price change: are new positions being added,
   * and in which direction, or is this an unwind? */
  function oiFactor(ctx) {
    var id = 'E2', group = 'E', name = 'Open interest vs price', weight = 0.06;
    var oh = ctx.oiHist;
    if (!oh || oh.length < 3) {
      return unavailable(id, group, name, weight, 'No open-interest history on this venue — weight redistributed');
    }
    var a = oh[0], b = oh[oh.length - 1];
    var oi0 = parseFloat(a.sumOpenInterest !== undefined ? a.sumOpenInterest : a.openInterest);
    var oi1 = parseFloat(b.sumOpenInterest !== undefined ? b.sumOpenInterest : b.openInterest);
    var t0 = Number(a.timestamp !== undefined ? a.timestamp : a.time);
    var t1 = Number(b.timestamp !== undefined ? b.timestamp : b.time);
    if (!oi0 || !oi1) return unavailable(id, group, name, weight, 'Open-interest values unreadable');
    var dOI = (oi1 - oi0) / oi0 * 100;
    var p0 = priceAtOrBefore(ctx.bars['1h'], t0), p1 = priceAtOrBefore(ctx.bars['1h'], t1);
    if (p0 === null || p1 === null) return unavailable(id, group, name, weight, 'No price series aligned to open interest');
    var dP = (p1 - p0) / p0 * 100;
    var strength = Math.min(1, Math.abs(dOI) / 3);
    var score, label;
    if (dOI > 0 && dP > 0) { score = strength; label = 'OI up with price — new longs adding, trend confirmed'; }
    else if (dOI > 0 && dP < 0) { score = -strength; label = 'OI up with price down — new shorts adding'; }
    else if (dOI < 0 && dP > 0) { score = -strength * 0.5; label = 'OI down with price up — short covering, not real demand'; }
    else if (dOI < 0 && dP < 0) { score = strength * 0.5; label = 'OI down with price down — long liquidation, not real supply'; }
    else { score = 0; label = 'Open interest flat'; }
    return factor(id, group, name, weight, score, label + '.',
      { openInterest: oi1, dOIPct: dOI, dPricePct: dP, strength: strength, windowMs: t1 - t0 });
  }

  /* Short-timescale aggressor skew: is the tape currently being lifted or hit? */
  function aggressionFactor(ctx) {
    var id = 'E3', group = 'E', name = 'Taker aggression (15m)', weight = 0.04;
    var p = ctx.prep['15m'];
    if (!p) return unavailable(id, group, name, weight, 'No 15m series configured');
    var i = p.n - 1;
    if (i < 100) return unavailable(id, group, name, weight, 'Need 100+ 15m bars for the aggression baseline');
    var ratios = [];
    for (var j = i - 99; j <= i; j++) {
      var b = p.bars[j];
      var tot = b.tbb + (b.v - b.tbb);
      ratios.push(tot ? b.tbb / tot : 0.5);
    }
    var m = I.mean(ratios), sd = I.stdevOf(ratios);
    var z = sd ? (ratios[ratios.length - 1] - m) / sd : 0;
    return factor(id, group, name, weight, I.softScale(z, -2, 2),
      'Taker buy share ' + (ratios[ratios.length - 1] * 100).toFixed(1) + '% vs a ' +
      (m * 100).toFixed(1) + '% baseline (' + z.toFixed(2) + 'σ) on 15m.',
      { takerBuyShare: ratios[ratios.length - 1], baseline: m, zScore: z });
  }

  /* Room to run: how much space there is above vs below before real structure. */
  function roomFactor(p, id, group, name, weight, tf) {
    var i = p.n - 1, c = p.c[i], a = p.atr14[i];
    if (!a) return unavailable(id, group, name, weight, 'ATR unavailable on ' + tf);
    var upRoom = null, downRoom = null;
    for (var j = 0; j < p.sw.highs.length; j++) {
      var hx = p.sw.highs[j];
      if (hx.i < i - 60) continue;
      if (hx.price > c) { upRoom = (hx.price - c) / a; break; }
    }
    for (var k = p.sw.lows.length - 1; k >= 0; k--) {
      var lx = p.sw.lows[k];
      if (lx.i < i - 60) continue;
      if (lx.price < c) { downRoom = (c - lx.price) / a; break; }
    }
    if (upRoom === null && downRoom === null) return unavailable(id, group, name, weight, 'No structure levels within 60 bars on ' + tf);
    var u = upRoom === null ? 6 : upRoom, d = downRoom === null ? 6 : downRoom;
    var score = I.clamp((u - d) / 3, -1, 1);
    return factor(id, group, name, weight, score,
      'Room to nearest swing high ' + (upRoom === null ? 'open (>6 ATR)' : upRoom.toFixed(2) + ' ATR') +
      ', to swing low ' + (downRoom === null ? 'open (>6 ATR)' : downRoom.toFixed(2) + ' ATR') + ' on ' + tf + '.',
      { upRoomAtr: upRoom, downRoomAtr: downRoom });
  }

  /* Stop-hunt signature: a wick through a prior swing that closes back inside. */
  function sweepFactor(p, id, group, name, weight, tf) {
    var i = p.n - 1, a = p.atr14[i];
    if (!a || i < 30) return unavailable(id, group, name, weight, 'Not enough bars on ' + tf);
    var best = null;
    for (var j = Math.max(1, i - 4); j <= i; j++) {
      var b = p.bars[j], rng = b.h - b.l;
      if (!rng) continue;
      for (var k = 0; k < p.sw.lows.length; k++) {
        var lx = p.sw.lows[k];
        if (lx.i >= j || lx.i < j - 30) continue;
        if (b.l < lx.price && b.c > lx.price) {
          var wick = (Math.min(b.o, b.c) - b.l) / rng;
          if (wick > 0.5) {
            var s = I.clamp((lx.price - b.l) / a, 0.1, 1);
            if (!best || s > Math.abs(best.score)) best = factor(id, group, name, weight, s,
              'Swept sell-side liquidity below ' + lx.price.toFixed(6) + ' then closed back above it (' + (wick * 100).toFixed(0) + '% lower wick) — stop hunt, bullish reversal signal.',
              { sweptLevel: lx.price, low: b.l, wickFrac: wick, barIndex: j });
          }
          break;
        }
      }
      for (var m = 0; m < p.sw.highs.length; m++) {
        var hx = p.sw.highs[m];
        if (hx.i >= j || hx.i < j - 30) continue;
        if (b.h > hx.price && b.c < hx.price) {
          var wickU = (b.h - Math.max(b.o, b.c)) / rng;
          if (wickU > 0.5) {
            var s2 = -I.clamp((b.h - hx.price) / a, 0.1, 1);
            if (!best || Math.abs(s2) > Math.abs(best.score)) best = factor(id, group, name, weight, s2,
              'Swept buy-side liquidity above ' + hx.price.toFixed(6) + ' then closed back below it (' + (wickU * 100).toFixed(0) + '% upper wick) — stop hunt, bearish reversal signal.',
              { sweptLevel: hx.price, high: b.h, wickFrac: wickU, barIndex: j });
          }
          break;
        }
      }
    }
    if (!best) return factor(id, group, name, weight, 0, 'No liquidity sweep in the last 5 bars on ' + tf + '.', {});
    return best;
  }

  /* Order-book imbalance inside 0.5% of mid. */
  function bookFactor(ctx) {
    var id = 'F3', group = 'F', name = 'Order book imbalance', weight = 0.03;
    var d = ctx.deriv || {};
    if (!d.depth || !d.depth.bids || !d.depth.asks) return unavailable(id, group, name, weight, 'No order book snapshot');
    var mid = lastPrice(ctx);
    if (!mid) return unavailable(id, group, name, weight, 'No mid price');
    var band = mid * 0.005, bv = 0, av = 0;
    d.depth.bids.forEach(function (r) { var p = parseFloat(r[0]); if (mid - p <= band) bv += parseFloat(r[1]) * p; });
    d.depth.asks.forEach(function (r) { var p = parseFloat(r[0]); if (p - mid <= band) av += parseFloat(r[1]) * p; });
    if (!bv && !av) return unavailable(id, group, name, weight, 'Order book empty inside the band');
    var imb = (bv - av) / (bv + av);
    return factor(id, group, name, weight, I.softScale(imb, -0.5, 0.5),
      'Book is ' + (imb > 0 ? 'bid' : 'ask') + '-heavy inside 0.5%: $' + Math.round(bv).toLocaleString() +
      ' bid vs $' + Math.round(av).toLocaleString() + ' ask (' + (imb * 100).toFixed(1) + '%).',
      { bidUsd: bv, askUsd: av, imbalance: imb });
  }

  /* ------------------------------------------------------------- weights
   *
   * Two profiles, both shipping so the difference is visible rather than hidden:
   *
   *  balanced  — the design prior: every facet gets weight because it sounds
   *              sensible. This is what a hand-built TA engine looks like.
   *  ic        — reweighted from data. Factors that measured NEGATIVE
   *              information coefficient in both studied windows (EMA-stack on
   *              both timeframes, RSI level, funding, channel position) drop to
   *              zero voting weight and stay in the UI as context only. Weight
   *              moves to the factors that actually predicted forward returns.
   *
   * The IC profile was fitted on one symbol set and one period; see
   * data/ic_study.json and the README for the out-of-sample result. Treat it as
   * an upper bound, not a promise.
   */
  var WEIGHTS = {
    balanced: {
      A1: 0.07, A2: 0.06, A3: 0.05, A4: 0.05, A5: 0.03,
      B1: 0.06, B2: 0.05, B3: 0.05, B4: 0.04,
      C1: 0.05, C2: 0.04, C3: 0.03,
      D1: 0.04, D2: 0.05, D3: 0.04, D4: 0.03,
      E1: 0.06, E2: 0.06, E3: 0.04,
      F1: 0.04, F2: 0.03, F3: 0.03
    },
    ic: {
      /* Positive information coefficient in BOTH studied windows -> carry real
       * weight. Negative in both -> muted to zero (still displayed as context).
       * Mixed across windows -> small weight, because regime-dependent is not
       * the same as useless but it is not trustworthy either. */
      B3: 0.15, C3: 0.12, F2: 0.09,
      A3: 0.05, A4: 0.05, C1: 0.06, C2: 0.05,
      D1: 0.04, D2: 0.05, D3: 0.05, D4: 0.03, B4: 0.05, B2: 0.03,
      E1: 0.02, E2: 0.06, E3: 0.04,
      F1: 0.03, F3: 0.02,
      A1: 0, A2: 0, A5: 0, B1: 0
    },
    /* A second, independent reweighting rule: promote whatever showed a strong
     * t-statistic in the longer 4h window. Kept in the build because it also
     * failed out of sample, and hiding that would make the other failures look
     * like the only ones. */
    icT: {
      A1: 0, A2: 0, A3: 0.07, A4: 0.05, A5: 0,
      B1: 0, B2: 0.03, B3: 0.09, B4: 0.10,
      C1: 0.11, C2: 0.02, C3: 0.07,
      D1: 0.07, D2: 0.03, D3: 0.08, D4: 0.03,
      E1: 0.02, E2: 0.07, E3: 0.05,
      F1: 0.04, F2: 0.05, F3: 0.02
    }
  };

  /* The default is the UNFITTED design prior. Two data-fitted weightings were
   * built and both failed on held-out symbols (see data/oos_test.json), so
   * making a fitted profile the default would be presenting an edge that the
   * project's own validation contradicts. */
  var DEFAULT_PROFILE = 'balanced';

  var PROFILE_LABELS = {
    balanced: 'Balanced prior (unfitted)',
    ic: 'IC-calibrated (both-window rule)',
    icT: 'IC-calibrated (strong-t rule)'
  };

  function sumWeights(w) {
    return Object.keys(w).reduce(function (a, k) { return a + w[k]; }, 0);
  }

  function isContextOnly(id, profile) {
    return profile === 'ic' && ['A1', 'A2', 'A5', 'B1', 'E1'].indexOf(id) !== -1;
  }

  /* -------------------------------------------------------------- helpers */

  function priceAtOrBefore(bars, ts) {
    if (!bars || !bars.length) return null;
    for (var i = bars.length - 1; i >= 0; i--) if (bars[i].t <= ts) return bars[i].c;
    return null;
  }

  function lastPrice(ctx) {
    var p = ctx.prep['1h'] || ctx.prep[Object.keys(ctx.prep)[0]];
    if (p && p.n) return p.c[p.n - 1];
    var t = ctx.deriv && ctx.deriv.ticker;
    return t ? parseFloat(t.lastPrice) : null;
  }

  /* ------------------------------------------------------------ composite */

  function buildFactors(ctx, profile) {
    profile = profile || DEFAULT_PROFILE;
    var WM = WEIGHTS[profile] || WEIGHTS.balanced;
    function W(id) { return WM[id] === undefined ? 0 : WM[id]; }
    var p1 = ctx.prep['1h'], p4 = ctx.prep['4h'], pd = ctx.prep['1d'];
    var out = [];
    if (!p1) return out;

    /* A — Trend */
    out.push(emaStackFactor(p1, 'A1', 'A', 'EMA stack (1h)', W('A1'), '1h'));
    out.push(p4 ? emaStackFactor(p4, 'A2', 'A', 'EMA stack (4h)', W('A2'), '4h') : unavailable('A2', 'A', 'EMA stack (4h)', W('A2'), 'No 4h series'));
    out.push(adxFactor(p1, 'A3', 'A', 'ADX / DMI (1h)', W('A3'), '1h'));
    out.push(structureFactor(p1, 'A4', 'A', 'Market structure (1h)', W('A4'), '1h'));
    out.push(donchianFactor(p1, 'A5', 'A', 'Channel position (1h)', W('A5'), '1h'));

    /* B — Momentum */
    out.push(rsiFactor(p1, 'B1', 'B', 'RSI level & slope (1h)', W('B1'), '1h'));
    out.push(divergenceFactor(p1, 'B2', 'B', 'RSI divergence (1h)', W('B2'), '1h'));
    out.push(macdFactor(p1, 'B3', 'B', 'MACD histogram (1h)', W('B3'), '1h'));
    out.push(rocFactor(p1, 'B4', 'B', 'Momentum / ATR (1h)', W('B4'), '1h'));

    /* C — Volatility & regime */
    out.push(breakoutFactor(p1, 'C1', 'C', 'Volatility breakout (1h)', W('C1'), '1h'));
    out.push(stretchFactor(p1, 'C2', 'C', 'Mean-reversion stretch (1h)', W('C2'), '1h'));
    out.push(autocorrFactor(p1, 'C3', 'C', 'Trend persistence (1h)', W('C3'), '1h'));

    /* D — Volume & flow */
    out.push(relVolFactor(p1, 'D1', 'D', 'Relative volume (1h)', W('D1'), '1h'));
    out.push(deltaFactor(p1, 'D2', 'D', 'Cumulative taker delta (1h)', W('D2'), '1h'));
    out.push(obvFactor(p1, 'D3', 'D', 'OBV trend (1h)', W('D3'), '1h'));
    out.push(vwapFactor(p1, 'D4', 'D', 'VWAP side (1h)', W('D4'), '1h'));

    /* E — Derivatives context */
    out.push(applyW(fundingFactor(ctx), W('E1')));
    out.push(applyW(oiFactor(ctx), W('E2')));
    out.push(applyW(aggressionFactor(ctx), W('E3')));

    /* F — Levels & liquidity */
    out.push(roomFactor(p1, 'F1', 'F', 'Room to structure (1h)', W('F1'), '1h'));
    out.push(sweepFactor(p1, 'F2', 'F', 'Liquidity sweep (1h)', W('F2'), '1h'));
    out.push(applyW(bookFactor(ctx), W('F3')));

    /* Daily EMA stack: context only, never votes. */
    if (pd) {
      var dTrend = emaStackFactor(pd, 'X1', 'X', 'EMA stack (1d)', 0, '1d');
      dTrend.contextOnly = true;
      out.push(dTrend);
    }

    /* Mark the factors this profile deliberately mutes, so the UI can show them
     * as evidence rather than pretending they still vote. */
    if (profile === 'ic') {
      out.forEach(function (f) {
        if (f.group !== 'X' && WM[f.id] === 0) f.mutedByProfile = true;
      });
    }
    return out;
  }

  function applyW(f, w) { f.weight = w === undefined ? 0 : w; return f; }

  function compositeOf(factors, declaredTotal) {
    var avail = factors.filter(function (f) { return f.available && f.weight > 0; });
    var wsum = I.sum(avail.map(function (f) { return f.weight; }));
    if (!wsum) return { composite: 0, agreement: 0, available: 0, total: 0, wsum: 0, voters: [], coverage: 0 };
    var raw = 0;
    avail.forEach(function (f) { raw += f.score * f.weight; });
    var composite = raw / wsum * 100;
    var votes = avail.filter(function (f) { return Math.abs(f.score) > 0.15; });
    var vw = I.sum(votes.map(function (f) { return f.weight * Math.abs(f.score); }));
    var agree = 0;
    votes.forEach(function (f) {
      if (sign(f.score) === sign(composite)) agree += f.weight * Math.abs(f.score);
    });
    var agreement = vw ? agree / vw : 0;
    /* Coverage is measured against the weight this profile DECLARES, so a
     * profile that mutes factors is not penalised for the muted ones. */
    var totalW = declaredTotal || 1.0;
    return {
      composite: composite, agreement: agreement,
      available: wsum, total: totalW,
      coverage: totalW ? Math.min(1, wsum / totalW) : 0,
      voters: votes.length,
      neutralCount: avail.length - votes.length,
      wsum: wsum
    };
  }

  /* ---------------------------------------------------------------- plan */

  function buildPlan(ctx, dir, factors, comp) {
    var p1 = ctx.prep['1h'];
    var i = p1.n - 1;
    var price = p1.c[i];
    var atr = p1.atr14[i];
    var warnings = [];
    if (!atr) return { ok: false, reason: 'ATR unavailable — cannot size a stop.' };

    /* Room to the nearest OPPOSING structure — the first level that can stall the
     * move (above price for a long, below for a short). Measured before the stop
     * because it constrains it: a stop wider than the available room guarantees
     * targets the market cannot reach. */
    var roomAtr = null;
    if (dir > 0) {
      for (var m = 0; m < p1.sw.highs.length; m++) {
        var hz = p1.sw.highs[m];
        if (hz.i < i - 60) continue;
        if (hz.price > price) { roomAtr = (hz.price - price) / atr; break; }
      }
    } else {
      for (var n = p1.sw.lows.length - 1; n >= 0; n--) {
        var lz = p1.sw.lows[n];
        if (lz.i < i - 60) continue;
        if (lz.price < price) { roomAtr = (price - lz.price) / atr; break; }
      }
    }

    /* Invalidation level: the nearest structure on the STOP side. The stop belongs
     * beyond it, or the level that proves the setup wrong is not covered. */
    var invalidDist = null;
    if (dir > 0) {
      for (var j = p1.sw.lows.length - 1; j >= 0; j--) {
        var lx = p1.sw.lows[j];
        if (lx.i >= i || lx.i < i - 40) continue;
        if (lx.price < price) { invalidDist = price - lx.price; break; }
      }
    } else {
      for (var k = p1.sw.highs.length - 1; k >= 0; k--) {
        var hx = p1.sw.highs[k];
        if (hx.i >= i || hx.i < i - 40) continue;
        if (hx.price > price) { invalidDist = hx.price - price; break; }
      }
    }

    var stopBase = CFG.atrStopMult * atr;
    var stopDist = stopBase;
    var validated = null;
    if (invalidDist !== null && invalidDist > stopBase && invalidDist < stopBase * 2.2) {
      stopDist = invalidDist * 1.15;
      validated = 'Stop widened to sit beyond the invalidation level ' + (invalidDist / atr).toFixed(2) + 'x ATR away, instead of a bare ATR stop.';
    }

    /* Cap the stop by the available room so the reward ladder stays reachable.
     * Without this, a 1.5x ATR stop against 0.9x ATR of room scores 0.6R and every
     * target sits at a level the market cannot reach before structure stops it. */
    if (roomAtr !== null) {
      var maxStopForRoom = (roomAtr * atr) / CFG.roomRR;
      var tightenFloor = CFG.minStopAtrMult * atr;
      if (stopDist > maxStopForRoom) {
        var tightened = Math.max(maxStopForRoom, tightenFloor);
        if (tightened < stopDist) {
          stopDist = tightened;
          /* The room cap overrode the structure widening, so reporting both would
           * read as contradictory. The cap is the binding constraint. */
          validated = null;
          warnings.push('Stop tightened to ' + (stopDist / atr).toFixed(2) + 'x ATR so the targets fit inside the ' +
            roomAtr.toFixed(2) + 'x ATR of room before the next structure.');
        }
      }
    }
    if (validated) warnings.push(validated);

    var floorD = price * CFG.stopFloorPct / 100, ceilD = price * CFG.stopCeilPct / 100;
    if (stopDist < floorD) { stopDist = floorD; warnings.push('Stop clamped up to the ' + CFG.stopFloorPct + '% floor.'); }
    if (stopDist > ceilD) { stopDist = ceilD; warnings.push('Stop clamped down to the ' + CFG.stopCeilPct + '% ceiling — structure stop was too wide.'); }

    /* No structure within 60 bars means open air, so every target fits. */
    var attainableR = roomAtr === null ? 5 : roomAtr / (stopDist / atr);

    var entry = price;
    var stop = entry - dir * stopDist;
    var targets = CFG.targets.map(function (t) {
      return {
        r: t.r, portion: t.portion,
        price: entry + dir * stopDist * t.r,
        /* A target beyond the nearest opposing structure is a stretch, not an
         * impossibility — a trend is expected to break structure. Flagging it is
         * more honest than silently promising the level. */
        reachable: t.r <= attainableR
      };
    });

    var stopPct = stopDist / entry * 100;
    var blendedR = targets.reduce(function (a, t) { return a + t.r * t.portion; }, 0);
    return {
      ok: true, dir: dir, side: dir > 0 ? 'LONG' : 'SHORT',
      entry: entry, stop: stop, stopDist: stopDist, stopPct: stopPct,
      atr: atr, atrPct: atr / entry * 100,
      targets: targets, blendedR: blendedR,
      roomAtr: roomAtr, invalidDist: invalidDist, attainableR: attainableR,
      warnings: warnings
    };
  }

  /* Position sizing — the part that turns a signal into a risk decision. */
  function positionSize(plan, opts) {
    var equity = opts.equity || 10000;
    var riskPct = opts.riskPct || 1;
    var leverage = opts.leverage || 5;
    var feePct = opts.feePct === undefined ? 0.035 : opts.feePct;
    var slipPct = opts.slipPct === undefined ? 0.02 : opts.slipPct;

    var riskUsd = equity * riskPct / 100;
    var qty = plan.stopDist ? riskUsd / plan.stopDist : 0;
    var notional = qty * plan.entry;
    var margin = leverage ? notional / leverage : notional;

    /* isolated-margin liquidation, ignoring maintenance margin for a first cut */
    var liqDist = plan.entry / leverage;
    var liqPrice = plan.dir > 0 ? plan.entry - liqDist : plan.entry + liqDist;
    var stopIsSafe = plan.stopDist < liqDist;
    var maxSafeLev = plan.stopDist > 0 ? Math.floor((plan.entry / plan.stopDist) * 0.5) : 0;

    var feesUsd = notional * (feePct / 100) * 2 + notional * (slipPct / 100) * 2;

    return {
      equity: equity, riskPct: riskPct, leverage: leverage,
      riskUsd: riskUsd, qty: qty, notional: notional, margin: margin,
      liquidationPrice: liqPrice, liquidationDistance: liqDist,
      stopIsSafe: stopIsSafe, maxSafeLeverage: maxSafeLev,
      feesUsd: feesUsd,
      lossAtStopUsd: riskUsd, lossAtStopWithCostsUsd: riskUsd + feesUsd,
      profitAt: plan.targets.map(function (t) {
        return { r: t.r, price: t.price, portion: t.portion, gainUsd: qty * plan.stopDist * t.r * t.portion };
      }),
      totalAtFinalTargetUsd: plan.targets.reduce(function (a, t) { return a + qty * plan.stopDist * t.r * t.portion; }, 0)
    };
  }

  /* -------------------------------------------------------------- verdict */

  function blk(code, text) { return { code: code, text: text }; }

  function analyze(ctx, opts) {
    opts = opts || {};
    ctx.prep = ctx.prep || {};
    ['15m', '1h', '4h', '1d'].forEach(function (tf) {
      if (!ctx.prep[tf] && ctx.bars[tf] && ctx.bars[tf].length) {
        var p = prep(ctx.bars[tf]);
        if (tf === '1h' || tf === '15m') withCumDelta(p);
        ctx.prep[tf] = p;
      }
    });
    if (ctx.prep['1h'] && !ctx.prep['1h'].cdN) withCumDelta(ctx.prep['1h']);

    var p1 = ctx.prep['1h'];
    if (!p1 || p1.n < 60) {
      return { ok: false, error: 'Need at least 60 hourly bars to analyse; got ' + (p1 ? p1.n : 0) + '.' };
    }

    var factors = buildFactors(ctx, opts.weights);
    var profile = typeof opts.weights === 'string' ? opts.weights : DEFAULT_PROFILE;
    var comp = compositeOf(factors, sumWeights(WEIGHTS[profile] || WEIGHTS.balanced));
    var price = p1.c[p1.n - 1];
    var atrPct = atrPctOf(p1, p1.n - 1);
    var ticker = (ctx.deriv && ctx.deriv.ticker) || {};
    var vol24h = ticker.quoteVolume !== undefined ? parseFloat(ticker.quoteVolume) : null;

    return finalize({
      ctx: ctx, factors: factors, comp: comp, price: price,
      atrPct: atrPct, vol24h: vol24h, opts: opts, symbol: ctx.symbol || '—',
      tf: opts.interval || '1h', profile: profile,
      strictness: opts.strictness || DEFAULT_STRICTNESS
    });
  }

  /* Shared verdict assembly so the backtest and the live path cannot drift. */
  function finalize(s) {
    var factors = s.factors, comp = s.comp, blockers = [], notes = [];
    var T = thresholdSet(s.strictness);
    var lz = leanOf(comp.composite);

    var dir = comp.composite > 0 ? 1 : comp.composite < 0 ? -1 : 0;

    if (Math.abs(comp.composite) < T.minComposite) {
      blockers.push(blk('BAND_MIN', 'Composite ' + comp.composite.toFixed(1) + ' is inside the ±' + T.minComposite + ' no-trade band — signals are too balanced to justify a position.'));
    }
    if (comp.agreement < T.minAgreement) {
      blockers.push(blk('AGREE', 'Only ' + (comp.agreement * 100).toFixed(0) + '% of the weighted evidence agrees on direction (needs ' + Math.round(T.minAgreement * 100) + '%) — the factors are fighting each other.'));
    }
    if (s.vol24h !== null && s.vol24h !== undefined && s.vol24h < T.minVolume24h) {
      blockers.push(blk('VOL24H', '24h quote volume $' + Math.round(s.vol24h).toLocaleString() + ' is under the $1M liquidity floor.'));
    }
    if (s.atrPct !== null && s.atrPct !== undefined) {
      if (s.atrPct < T.minAtrPct) blockers.push(blk('VOL_LOW', 'Realised volatility ' + s.atrPct.toFixed(3) + '% per bar is too low — no movement to capture.'));
      if (s.atrPct > T.maxAtrPct) blockers.push(blk('VOL_HIGH', 'Realised volatility ' + s.atrPct.toFixed(2) + '% per bar is extreme — stop placement cannot be trusted.'));
    }
    if (comp.coverage < 0.8) {
      blockers.push(blk('COVERAGE', 'Only ' + (comp.coverage * 100).toFixed(0) + '% of the model weight had data available.'));
    }

    var plan = null, size = null, roomBlocked = false;
    /* Levels are only built when there is an actual directional read; a neutral
     * composite has no side to plan for. */
    if (dir !== 0 && lz.sign !== 0) {
      plan = buildPlan(s.ctx, dir, factors, comp);
      if (plan && plan.ok) {
        if (plan.attainableR < T.minAttainableR) {
          blockers.push(blk('ROOM', 'Only ' + plan.attainableR.toFixed(2) + 'R of room before the next opposing structure (needs ' + T.minAttainableR + 'R) — price is boxed in against structure, with nowhere for the trade to travel.'));
          /* No coherent geometry exists: any target ladder would sit at levels the
           * market cannot reach. Withhold the levels rather than draw fiction, but
           * keep the direction and the evidence. */
          roomBlocked = true;
        }
        size = positionSize(plan, {
          equity: s.opts.equity, riskPct: s.opts.riskPct, leverage: s.opts.leverage,
          feePct: s.opts.feePct, slipPct: s.opts.slipPct
        });
        if (!size.stopIsSafe) {
          blockers.push(blk('LIQ', 'At ' + size.leverage + 'x the liquidation price sits inside the stop — leverage exceeds the ' + size.maxSafeLeverage + 'x the stop distance supports.'));
        }
        plan.warnings.forEach(function (w) { notes.push(w); });
      } else if (plan) {
        blockers.push(blk('PLAN', plan.reason));
        plan = null;
      }
    }

    /* Confidence blends agreement, conviction magnitude and regime clarity. */
    var magnitude = Math.min(1, Math.abs(comp.composite) / 70);
    var adxNow = s.ctx.prep['1h'].adx.adx[s.ctx.prep['1h'].n - 1];
    var clarity = adxNow === null ? 0.5 : I.clamp(0.45 + adxNow / 60, 0.45, 1);
    var confidence = I.clamp(100 * (0.45 * comp.agreement + 0.40 * magnitude + 0.15 * clarity), 0, 100);

    /* A directional read with computable levels is useful even when the risk
     * gates reject it, so it is surfaced as an explicit SETUP instead of being
     * swallowed into NO TRADE. The distinction between a gate-filtered TRADE and
     * an unfiltered SETUP is the point — the failing gates are listed either way,
     * and nothing is dressed up as validated when it is not. */
    var hasDirection = dir !== 0 && lz.sign !== 0 && plan !== null;
    var hasTrade = blockers.length === 0 && hasDirection;
    var hasSetup = !hasTrade && hasDirection;
    var tier = 'NONE';
    if (hasTrade) {
      if (Math.abs(comp.composite) >= 60 && comp.agreement >= 0.72 && confidence >= 70) tier = 'HIGH';
      else if (Math.abs(comp.composite) >= 40 && confidence >= 55) tier = 'MEDIUM';
      else tier = 'LOW';
    } else if (hasSetup) {
      tier = 'WATCH';
    }
    var verdict = hasTrade ? (dir > 0 ? 'LONG' : 'SHORT')
      : hasSetup ? ('SETUP ' + lz.lean)
      : 'NO TRADE';

    /* Group rollups for the UI. */
    var groups = GROUPS.map(function (g) {
      var fs = factors.filter(function (f) { return f.group === g.id; });
      var aw = I.sum(fs.filter(function (f) { return f.available; }).map(function (f) { return f.weight; }));
      var raw = I.sum(fs.filter(function (f) { return f.available; }).map(function (f) { return f.score * f.weight; }));
      return {
        id: g.id, name: g.name, weight: g.weight, blurb: g.blurb,
        score: aw ? raw / aw : 0,
        available: aw > 0,
        factors: fs
      };
    });
    /* Context-only factors (daily EMA stack) live outside the voting groups, so
     * they must be collected from the factor list — filtering the group rollups
     * for an 'X' group always returns nothing, because GROUPS has no 'X' entry. */
    var contextFactors = factors.filter(function (f) { return f.group === 'X'; });

    return {
      ok: true, version: VERSION,
      symbol: s.symbol, interval: s.tf, ts: Date.now(),
      profile: s.profile || DEFAULT_PROFILE,
      strictness: s.strictness || DEFAULT_STRICTNESS,
      thresholds: T,
      lean: lz.lean, leanSign: lz.sign,
      price: s.price, atrPct: s.atrPct,
      composite: Math.round(comp.composite * 10) / 10,
      confidence: Math.round(confidence * 10) / 10,
      agreement: comp.agreement, coverage: comp.coverage,
      verdict: verdict,
      direction: hasTrade ? dir : 0,
      leanDir: dir,
      hasTrade: hasTrade, hasSetup: hasSetup,
      tier: tier,
      blockers: blockers, notes: notes,
      groups: groups,
      contextFactors: contextFactors,
      plan: roomBlocked ? null : plan,
      size: roomBlocked ? null : size,
      roomBlocked: roomBlocked,
      warnings: buildWarnings(s)
    };
  }

  function buildWarnings(s) {
    var w = [];
    var missing = s.factors.filter(function (f) { return !f.available && f.weight > 0; });
    if (missing.length) {
      w.push('Inactive this run (weight redistributed): ' + missing.map(function (f) { return f.id + ' ' + f.name; }).join(', ') + '.');
    }
    w.push('This is a technical model, not a forecast. It has no view on news, listings, or protocol events.');
    return w;
  }

  return {
    VERSION: VERSION, CFG: CFG, GROUPS: GROUPS, WEIGHTS: WEIGHTS,
    DEFAULT_PROFILE: DEFAULT_PROFILE, PROFILE_LABELS: PROFILE_LABELS,
    STRICTNESS: STRICTNESS, DEFAULT_STRICTNESS: DEFAULT_STRICTNESS,
    thresholdSet: thresholdSet, leanOf: leanOf,
    sumWeights: sumWeights, isContextOnly: isContextOnly,
    prep: prep, withCumDelta: withCumDelta,
    buildFactors: buildFactors, compositeOf: compositeOf,
    buildPlan: buildPlan, positionSize: positionSize,
    analyze: analyze, finalize: finalize,
    priceAtOrBefore: priceAtOrBefore,
    sign: sign
  };
});
