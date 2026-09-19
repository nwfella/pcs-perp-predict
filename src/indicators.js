/* PCS-Perp-Predict — indicator math.
 * Pure functions, no dependencies, no DOM. All series are arrays aligned 1:1
 * with the input, with `null` filling the warm-up region so callers can index
 * any series by bar index without offset arithmetic.
 *
 * Works in the browser (attaches globalThis.PPIndicators) and in Node
 * (module.exports) so the same code is unit-tested and shipped.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PPIndicators = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function mean(a) {
    if (!a.length) return null;
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i];
    return s / a.length;
  }

  function sum(a) {
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i];
    return s;
  }

  function last(a) {
    return a.length ? a[a.length - 1] : null;
  }

  /* Last non-null value of a series. */
  function lastValid(a) {
    for (var i = a.length - 1; i >= 0; i--) if (a[i] !== null && a[i] !== undefined && !isNaN(a[i])) return a[i];
    return null;
  }

  function lastValidIndex(a) {
    for (var i = a.length - 1; i >= 0; i--) if (a[i] !== null && a[i] !== undefined && !isNaN(a[i])) return i;
    return -1;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /* Map a value from one range onto [-1, 1], clamped. Used to turn raw
   * indicator readings into factor scores. */
  function scale(v, lo, hi) {
    if (hi === lo) return 0;
    return clamp(((v - lo) / (hi - lo)) * 2 - 1, -1, 1);
  }

  /* Smooth squash from a raw range onto [-1, 1].
   *
   * Uses smootherstep, which is only defined on [0, 1], so it is applied to
   * |t| and the sign re-applied. Applying the polynomial directly to negative
   * t is not the odd function you would hope for (it evaluates to -2.375 at
   * t = -0.5) and saturates every bearish reading to exactly -1. */
  function softScale(v, lo, hi) {
    var t = clamp(scale(v, lo, hi), -1, 1);
    var a = Math.abs(t);
    var s = a * a * a * (a * (a * 6 - 15) + 10);
    return t < 0 ? -s : s;
  }

  function sma(values, period) {
    var n = values.length, out = new Array(n).fill(null), s = 0;
    for (var i = 0; i < n; i++) {
      s += values[i];
      if (i >= period) s -= values[i - period];
      if (i >= period - 1) out[i] = s / period;
    }
    return out;
  }

  /* Exponential MA, seeded with the SMA of the first `period` values (the
   * convention every charting package uses, so readings match TradingView). */
  function ema(values, period) {
    var n = values.length, out = new Array(n).fill(null);
    if (n < period) return out;
    var k = 2 / (period + 1), s = 0;
    for (var i = 0; i < period; i++) s += values[i];
    var prev = s / period;
    out[period - 1] = prev;
    for (var j = period; j < n; j++) {
      prev = values[j] * k + prev * (1 - k);
      out[j] = prev;
    }
    return out;
  }

  /* Rolling population standard deviation (matches Bollinger Band convention). */
  function stdev(values, period) {
    var n = values.length, out = new Array(n).fill(null), s = 0, sq = 0;
    for (var i = 0; i < n; i++) {
      s += values[i];
      sq += values[i] * values[i];
      if (i >= period) {
        s -= values[i - period];
        sq -= values[i - period] * values[i - period];
      }
      if (i >= period - 1) {
        var m = s / period;
        out[i] = Math.sqrt(Math.max(0, sq / period - m * m));
      }
    }
    return out;
  }

  /* Wilder's RSI. */
  function rsi(values, period) {
    period = period || 14;
    var n = values.length, out = new Array(n).fill(null);
    if (n <= period) return out;
    var gain = 0, loss = 0;
    for (var i = 1; i <= period; i++) {
      var d0 = values[i] - values[i - 1];
      if (d0 >= 0) gain += d0; else loss -= d0;
    }
    var ag = gain / period, al = loss / period;
    out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    for (var j = period + 1; j < n; j++) {
      var d = values[j] - values[j - 1];
      ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
      al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
      out[j] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    return out;
  }

  function macd(values, fast, slow, signal) {
    fast = fast || 12; slow = slow || 26; signal = signal || 9;
    var ef = ema(values, fast), es = ema(values, slow);
    var n = values.length, line = new Array(n).fill(null);
    for (var i = 0; i < n; i++) if (ef[i] !== null && es[i] !== null) line[i] = ef[i] - es[i];
    var firstIdx = lastValidIndex(line);
    var compact = [];
    var start = -1;
    for (var j = 0; j < n; j++) {
      if (line[j] !== null) { start = j; break; }
    }
    if (start < 0) return { macd: line, signal: new Array(n).fill(null), hist: new Array(n).fill(null) };
    for (var k = start; k < n; k++) compact.push(line[k]);
    var sigCompact = ema(compact, signal);
    var sig = new Array(n).fill(null), hist = new Array(n).fill(null);
    for (var m = 0; m < compact.length; m++) {
      sig[start + m] = sigCompact[m];
      if (sigCompact[m] !== null) hist[start + m] = compact[m] - sigCompact[m];
    }
    void firstIdx;
    return { macd: line, signal: sig, hist: hist };
  }

  function trueRange(high, low, close) {
    var n = close.length, tr = new Array(n).fill(null);
    for (var i = 0; i < n; i++) {
      if (i === 0) { tr[i] = high[i] - low[i]; continue; }
      tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
    }
    return tr;
  }

  /* Wilder-smoothed ATR. */
  function atr(high, low, close, period) {
    period = period || 14;
    var n = close.length, tr = trueRange(high, low, close), out = new Array(n).fill(null);
    if (n < period + 1) return out;
    var s = 0;
    for (var i = 1; i <= period; i++) s += tr[i];
    var prev = s / period;
    out[period] = prev;
    for (var j = period + 1; j < n; j++) {
      prev = (prev * (period - 1) + tr[j]) / period;
      out[j] = prev;
    }
    return out;
  }

  /* Wilder's ADX / DI+ / DI-. */
  function adxSeries(high, low, close, period) {
    period = period || 14;
    var n = close.length;
    var plusDM = new Array(n).fill(0), minusDM = new Array(n).fill(0), tr = new Array(n).fill(0);
    for (var i = 1; i < n; i++) {
      var up = high[i] - high[i - 1], dn = low[i - 1] - low[i];
      plusDM[i] = (up > dn && up > 0) ? up : 0;
      minusDM[i] = (dn > up && dn > 0) ? dn : 0;
      tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
    }
    var pdi = new Array(n).fill(null), mdi = new Array(n).fill(null), adx = new Array(n).fill(null);
    var dx = new Array(n).fill(null);
    if (n < period * 2 + 2) return { adx: adx, plusDI: pdi, minusDI: mdi };
    var trS = 0, pS = 0, mS = 0;
    for (var a = 1; a <= period; a++) { trS += tr[a]; pS += plusDM[a]; mS += minusDM[a]; }
    var pD = 100 * pS / (trS || 1), mD = 100 * mS / (trS || 1);
    pdi[period] = pD; mdi[period] = mD;
    dx[period] = 100 * Math.abs(pD - mD) / ((pD + mD) || 1);
    for (var b = period + 1; b < n; b++) {
      trS = trS - trS / period + tr[b];
      pS = pS - pS / period + plusDM[b];
      mS = mS - mS / period + minusDM[b];
      pD = 100 * pS / (trS || 1); mD = 100 * mS / (trS || 1);
      pdi[b] = pD; mdi[b] = mD;
      dx[b] = 100 * Math.abs(pD - mD) / ((pD + mD) || 1);
    }
    var dsum = 0, cnt = 0;
    for (var c = period; c < period * 2 && c < n; c++) { if (dx[c] !== null) { dsum += dx[c]; cnt++; } }
    if (!cnt) return { adx: adx, plusDI: pdi, minusDI: mdi };
    var first = period * 2 - 1;
    var prevAdx = dsum / cnt;
    if (first < n) adx[first] = prevAdx;
    for (var d = first + 1; d < n; d++) {
      if (dx[d] === null) continue;
      prevAdx = (prevAdx * (period - 1) + dx[d]) / period;
      adx[d] = prevAdx;
    }
    return { adx: adx, plusDI: pdi, minusDI: mdi };
  }

  function bollinger(values, period, mult) {
    period = period || 20; mult = mult === undefined ? 2 : mult;
    var mid = sma(values, period), sd = stdev(values, period);
    var n = values.length, upper = new Array(n).fill(null), lower = new Array(n).fill(null),
        width = new Array(n).fill(null), z = new Array(n).fill(null);
    for (var i = 0; i < n; i++) {
      if (mid[i] === null || sd[i] === null) continue;
      upper[i] = mid[i] + mult * sd[i];
      lower[i] = mid[i] - mult * sd[i];
      width[i] = mid[i] ? (upper[i] - lower[i]) / mid[i] * 100 : null;
      z[i] = sd[i] ? (values[i] - mid[i]) / sd[i] : 0;
    }
    return { mid: mid, upper: upper, lower: lower, width: width, z: z };
  }

  function stochastic(high, low, close, period, smoothK, smoothD) {
    period = period || 14; smoothK = smoothK || 3; smoothD = smoothD || 3;
    var n = close.length, raw = new Array(n).fill(null);
    for (var i = period - 1; i < n; i++) {
      var hh = -Infinity, ll = Infinity;
      for (var j = i - period + 1; j <= i; j++) {
        if (high[j] > hh) hh = high[j];
        if (low[j] < ll) ll = low[j];
      }
      raw[i] = hh === ll ? 50 : (close[i] - ll) / (hh - ll) * 100;
    }
    var k = sma(raw.map(function (v) { return v === null ? 0 : v; }), smoothK);
    for (var m = 0; m < n; m++) if (raw[m] === null) k[m] = null;
    var d = sma(k.map(function (v) { return v === null ? 0 : v; }), smoothD);
    for (var p = 0; p < n; p++) if (k[p] === null) d[p] = null;
    return { k: k, d: d };
  }

  /* On-balance volume. */
  function obv(close, volume) {
    var n = close.length, out = new Array(n).fill(null);
    out[0] = 0;
    for (var i = 1; i < n; i++) {
      out[i] = out[i - 1] + (close[i] > close[i - 1] ? volume[i] : close[i] < close[i - 1] ? -volume[i] : 0);
    }
    return out;
  }

  function roc(values, period) {
    var n = values.length, out = new Array(n).fill(null);
    for (var i = period; i < n; i++) {
      out[i] = values[i - period] ? (values[i] - values[i - period]) / values[i - period] * 100 : null;
    }
    return out;
  }

  /* Rolling VWAP over `period` bars (typical price weighted). */
  function vwap(high, low, close, volume, period) {
    var n = close.length, out = new Array(n).fill(null);
    for (var i = period - 1; i < n; i++) {
      var pv = 0, vv = 0;
      for (var j = i - period + 1; j <= i; j++) {
        var tp = (high[j] + low[j] + close[j]) / 3;
        pv += tp * volume[j];
        vv += volume[j];
      }
      out[i] = vv ? pv / vv : null;
    }
    return out;
  }

  /* Donchian channel. `pos` (0..1) is where the bar's high-low range sits
   * inside the channel, computed per bar so it lines up with its own bar. */
  function donchian(high, low, period) {
    var n = high.length, up = new Array(n).fill(null), dn = new Array(n).fill(null), pos = new Array(n).fill(null);
    for (var i = period - 1; i < n; i++) {
      var hh = -Infinity, ll = Infinity;
      for (var j = i - period + 1; j <= i; j++) {
        if (high[j] > hh) hh = high[j];
        if (low[j] < ll) ll = low[j];
      }
      up[i] = hh; dn[i] = ll;
      pos[i] = hh === ll ? 0.5 : (high[i] - ll) / (hh - ll);
    }
    return { upper: up, lower: dn, pos: pos };
  }

  /* Fractal swing points: a bar whose high beats `k` bars either side. */
  function swings(high, low, k) {
    k = k || 2;
    var highs = [], lows = [];
    for (var i = k; i < high.length - k; i++) {
      var isH = true, isL = true;
      for (var j = 1; j <= k; j++) {
        if (high[i] <= high[i - j] || high[i] <= high[i + j]) isH = false;
        if (low[i] >= low[i - j] || low[i] >= low[i + j]) isL = false;
      }
      if (isH) highs.push({ i: i, price: high[i] });
      if (isL) lows.push({ i: i, price: low[i] });
    }
    return { highs: highs, lows: lows };
  }

  /* Least-squares slope of y over x=0..n-1, normalised by mean|y| so the result
   * is comparable across instruments. */
  function normSlope(values, period) {
    var n = values.length;
    if (n < period) return null;
    var ys = values.slice(n - period).map(function (v) { return v === null ? 0 : v; });
    var mx = (period - 1) / 2, my = mean(ys);
    var num = 0, den = 0, absy = 0;
    for (var i = 0; i < period; i++) {
      num += (i - mx) * (ys[i] - my);
      den += (i - mx) * (i - mx);
      absy += Math.abs(ys[i]);
    }
    if (!den || !absy) return null;
    return (num / den) / (absy / period);
  }

  /* Percentile rank of the final value within the whole series, 0..1. */
  function percentileRank(series) {
    var v = series.filter(function (x) { return x !== null && x !== undefined && !isNaN(x); });
    if (v.length < 5) return null;
    var cur = v[v.length - 1], below = 0;
    for (var i = 0; i < v.length; i++) if (v[i] <= cur) below++;
    return below / v.length;
  }

  function stdevOf(a) {
    if (a.length < 2) return 0;
    var m = mean(a), s = 0;
    for (var i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
    return Math.sqrt(s / a.length);
  }

  /* Correlation of two equal-length arrays. */
  function corr(a, b) {
    var n = Math.min(a.length, b.length);
    if (n < 3) return 0;
    var ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
    var num = 0, da = 0, db = 0;
    for (var i = 0; i < n; i++) {
      var x = a[i] - ma, y = b[i] - mb;
      num += x * y; da += x * x; db += y * y;
    }
    if (!da || !db) return 0;
    return num / Math.sqrt(da * db);
  }

  /* Convert Aster kline rows into a plain bar array. Rows are:
   * [openTime, open, high, low, close, volume, closeTime, quoteVolume,
   *  count, takerBuyBase, takerBuyQuote, ignore] */
  function parseKlines(rows) {
    return rows.map(function (r) {
      return {
        t: Number(r[0]),
        o: parseFloat(r[1]),
        h: parseFloat(r[2]),
        l: parseFloat(r[3]),
        c: parseFloat(r[4]),
        v: parseFloat(r[5]),
        ct: Number(r[6]),
        q: parseFloat(r[7]),
        n: Number(r[8]),
        tbb: parseFloat(r[9]),   // taker buy base volume
        tba: parseFloat(r[10])   // taker buy quote volume
      };
    });
  }

  function cols(bars, key) {
    return bars.map(function (b) { return b[key]; });
  }

  /* Taker sell base volume = total volume - taker buy volume. Gives a real
   * signed flow series instead of the usual close-to-close guess. */
  function deltaVolume(bars) {
    return bars.map(function (b) { return b.tbb - (b.v - b.tbb); });
  }

  function cumsum(a) {
    var out = new Array(a.length), s = 0;
    for (var i = 0; i < a.length; i++) { s += a[i]; out[i] = s; }
    return out;
  }

  return {
    mean: mean, sum: sum, last: last, lastValid: lastValid, lastValidIndex: lastValidIndex,
    clamp: clamp, scale: scale, softScale: softScale,
    sma: sma, ema: ema, stdev: stdev, stdevOf: stdevOf, rsi: rsi, macd: macd,
    trueRange: trueRange, atr: atr, adx: adxSeries, bollinger: bollinger,
    stochastic: stochastic, obv: obv, roc: roc, vwap: vwap, donchian: donchian,
    swings: swings, normSlope: normSlope, percentileRank: percentileRank,
    corr: corr, parseKlines: parseKlines, cols: cols, deltaVolume: deltaVolume,
    cumsum: cumsum
  };
});
