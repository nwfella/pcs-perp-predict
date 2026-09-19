/* PCS-Perp-Predict — canvas chart.
 * Candlesticks, EMA overlays, Bollinger band, and the trade plan's
 * entry/stop/target levels drawn at their real prices. No chart library. */

(function (root, factory) {
  var api = factory(
    (typeof module === 'object' && module.exports) ? require('./indicators.js')
      : (typeof globalThis !== 'undefined' ? globalThis.PPIndicators : null)
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PPChart = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (I) {
  'use strict';

  var THEME = {
    up: '#2fd07a', down: '#ff5d6c',
    grid: 'rgba(255,255,255,0.05)', axis: '#6b6b85', text: '#9a9ab5',
    ema20: '#f0b90b', ema50: '#4a9eff', ema200: '#c56cff',
    bb: 'rgba(120,120,200,0.28)',
    entry: '#4a9eff', stop: '#ff5d6c', tp: '#2fd07a', vwap: '#00c2c7'
  };

  /* Accepts numbers or numeric strings: the exchange returns prices as strings,
   * and Math.abs() would silently coerce one while .toFixed() then throws. */
  function fmtPrice(v) {
    if (v === null || v === undefined || v === '') return '—';
    var n = typeof v === 'number' ? v : Number(v);
    if (!isFinite(n)) return '—';
    var a = Math.abs(n);
    if (a >= 10000) return n.toFixed(1);
    if (a >= 100) return n.toFixed(2);
    if (a >= 1) return n.toFixed(3);
    if (a >= 0.01) return n.toFixed(5);
    return n.toFixed(7);
  }

  /* Crisp canvas: back the bitmap by devicePixelRatio and scale the context so
   * all drawing stays in CSS pixels. */
  function surface(canvas, cssH) {
    var dpr = window.devicePixelRatio || 1;
    var cssW = canvas.clientWidth || canvas.parentElement.clientWidth || 640;
    var h = cssH || canvas.clientHeight || 320;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.height = h + 'px';
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, h);
    return { ctx: ctx, w: cssW, h: h };
  }

  /* Draw candles + overlays + plan levels.
   *   opts: { bars, series:{ema20,ema50,ema200,bb,vwap}, plan, showBB, tail } */
  function drawPrice(canvas, opts) {
    var s = surface(canvas, opts.height || 340);
    var ctx = s.ctx, W = s.w, H = s.h;
    var tail = opts.tail || 160;
    var all = opts.bars;
    var from = Math.max(0, all.length - tail);
    var bars = all.slice(from);
    var ser = opts.series || {};
    var slice = function (arr) { return arr ? arr.slice(from) : null; };

    var PADL = 8, PADR = 74, PADT = 14, PADB = 22;
    var plotW = W - PADL - PADR, plotH = H - PADT - PADB;
    if (plotW <= 10 || !bars.length) return { w: W, h: H, drawn: 0 };

    /* price range spans candles, overlays and any visible plan level */
    var lo = Infinity, hi = -Infinity;
    var consider = function (v) { if (v !== null && v !== undefined && !isNaN(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } };
    bars.forEach(function (b) { consider(b.l); consider(b.h); });
    ['ema20', 'ema50', 'ema200', 'vwap'].forEach(function (k) {
      var a = slice(ser[k]); if (a) a.forEach(consider);
    });
    var bbU = slice(ser.bb && ser.bb.upper), bbL = slice(ser.bb && ser.bb.lower);
    if (opts.showBB && bbU) { bbU.forEach(consider); bbL.forEach(consider); }
    if (opts.plan) {
      consider(opts.plan.stop);
      opts.plan.targets.forEach(function (t) { consider(t.price); });
    }
    if (!isFinite(lo) || !isFinite(hi)) return { w: W, h: H, drawn: 0 };
    var pad = (hi - lo) * 0.06 || hi * 0.01 || 1;
    lo -= pad; hi += pad;
    var yOf = function (p) { return PADT + (hi - p) / (hi - lo) * plotH; };
    var bw = plotW / bars.length;
    var xOf = function (i) { return PADL + i * bw + bw / 2; };

    /* grid + price axis */
    ctx.strokeStyle = THEME.grid; ctx.lineWidth = 1;
    ctx.font = '10px ui-monospace,SFMono-Regular,Menlo,monospace';
    ctx.fillStyle = THEME.axis; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (var g = 0; g <= 4; g++) {
      var y = PADT + plotH * g / 4;
      ctx.beginPath(); ctx.moveTo(PADL, Math.round(y) + .5); ctx.lineTo(PADL + plotW, Math.round(y) + .5); ctx.stroke();
      ctx.fillText(fmtPrice(hi - (hi - lo) * g / 4), PADL + plotW + 6, y);
    }

    /* Bollinger band fill */
    if (opts.showBB && bbU && bbL) {
      ctx.beginPath();
      ctx.moveTo(xOf(0), yOf(bbU[0]));
      for (var i = 1; i < bars.length; i++) ctx.lineTo(xOf(i), yOf(bbU[i]));
      for (var j = bars.length - 1; j >= 0; j--) if (bbL[j] !== null) ctx.lineTo(xOf(j), yOf(bbL[j]));
      ctx.closePath();
      ctx.fillStyle = THEME.bb; ctx.fill();
    }

    /* candles */
    var bodyW = Math.max(1, Math.min(bw * 0.7, 11));
    bars.forEach(function (b, i) {
      var up = b.c >= b.o;
      var col = up ? THEME.up : THEME.down;
      ctx.strokeStyle = col; ctx.fillStyle = col;
      var x = xOf(i);
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + .5, yOf(b.h));
      ctx.lineTo(Math.round(x) + .5, yOf(b.l));
      ctx.stroke();
      var yo = yOf(b.o), yc = yOf(b.c);
      var top = Math.min(yo, yc), hgt = Math.max(1, Math.abs(yc - yo));
      ctx.fillRect(x - bodyW / 2, top, bodyW, hgt);
    });

    /* overlay lines */
    var line = function (arr, color, width) {
      if (!arr) return;
      ctx.strokeStyle = color; ctx.lineWidth = width || 1.4;
      ctx.beginPath();
      var started = false;
      arr.forEach(function (v, i) {
        if (v === null || v === undefined || isNaN(v)) { started = false; return; }
        if (!started) { ctx.moveTo(xOf(i), yOf(v)); started = true; }
        else ctx.lineTo(xOf(i), yOf(v));
      });
      ctx.stroke();
    };
    line(slice(ser.ema200), THEME.ema200);
    line(slice(ser.ema50), THEME.ema50);
    line(slice(ser.ema20), THEME.ema20);
    if (opts.showVwap) line(slice(ser.vwap), THEME.vwap, 1.2);

    /* plan levels: dashed lines with right-edge labels */
    if (opts.plan) {
      var label = function (price, color, text) {
        if (price === null || price === undefined) return;
        var y = yOf(price);
        if (y < PADT - 2 || y > PADT + plotH + 2) return;
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = color; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(PADL, Math.round(y) + .5); ctx.lineTo(PADL + plotW, Math.round(y) + .5); ctx.stroke();
        ctx.restore();
        ctx.fillStyle = color;
        ctx.font = 'bold 9px ui-monospace,SFMono-Regular,Menlo,monospace';
        ctx.fillText(text, PADL + 4, y - 6);
      };
      label(opts.plan.entry, THEME.entry, 'ENTRY ' + fmtPrice(opts.plan.entry));
      label(opts.plan.stop, THEME.stop, 'STOP ' + fmtPrice(opts.plan.stop));
      opts.plan.targets.forEach(function (t, idx) {
        label(t.price, THEME.tp, 'TP' + (idx + 1) + ' ' + t.r + 'R ' + fmtPrice(t.price));
      });
    }

    ctx.strokeStyle = THEME.grid;
    ctx.beginPath(); ctx.moveTo(PADL, PADT + plotH + .5); ctx.lineTo(PADL + plotW, PADT + plotH + .5); ctx.stroke();
    return { w: W, h: H, drawn: bars.length };
  }

  /* Small R-multiple equity curve for the backtest panel. */
  function drawEquity(canvas, curve) {
    var s = surface(canvas, 120);
    var ctx = s.ctx, W = s.w, H = s.h;
    if (!curve || curve.length < 2) {
      ctx.fillStyle = THEME.text; ctx.font = '11px system-ui'; ctx.textAlign = 'center';
      ctx.fillText('no trades', W / 2, H / 2);
      return;
    }
    var PAD = 8;
    var vals = curve.map(function (p) { return p.equity; });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi === lo) hi = lo + 1;
    var xOf = function (i) { return PAD + i / (curve.length - 1) * (W - PAD * 2); };
    var yOf = function (v) { return H - PAD - (v - lo) / (hi - lo) * (H - PAD * 2); };

    /* baseline at starting equity */
    var start = curve[0].equity;
    ctx.strokeStyle = THEME.grid; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(PAD, yOf(start)); ctx.lineTo(W - PAD, yOf(start)); ctx.stroke();
    ctx.setLineDash([]);

    var final = vals[vals.length - 1];
    var col = final >= start ? THEME.up : THEME.down;
    var grad = ctx.createLinearGradient(0, PAD, 0, H - PAD);
    grad.addColorStop(0, final >= start ? 'rgba(47,208,122,0.28)' : 'rgba(255,93,108,0.28)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');

    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(curve[0].equity));
    curve.forEach(function (p, i) { ctx.lineTo(xOf(i), yOf(p.equity)); });
    ctx.lineTo(xOf(curve.length - 1), H - PAD);
    ctx.lineTo(xOf(0), H - PAD);
    ctx.closePath(); ctx.fillStyle = grad; ctx.fill();

    ctx.beginPath();
    curve.forEach(function (p, i) { i ? ctx.lineTo(xOf(i), yOf(p.equity)) : ctx.moveTo(xOf(i), yOf(p.equity)); });
    ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.stroke();
  }

  return { drawPrice: drawPrice, drawEquity: drawEquity, fmtPrice: fmtPrice, THEME: THEME };
});
