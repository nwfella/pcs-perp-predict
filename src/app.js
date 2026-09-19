/* PCS-Perp-Predict — application shell.
 *
 * Wires the data client, engine and chart into the page. No framework, no
 * dependencies. State is a single object; every render is a pure function of it.
 *
 * Design intent: this is an instrument, not an oracle. The verdict is always
 * shown next to the model's own measured expectancy, and nothing in the UI is
 * allowed to imply an edge the validation data does not support.
 */
(function () {
  'use strict';

  var D = window.PPData, E = window.PPEngine, B = window.PPBacktest,
      C = window.PPChart, I = window.PPIndicators;
  var V = window.PP_VALIDATION || {};

  var LS = {
    get: function (k, dflt) {
      try { var v = localStorage.getItem('ppp.' + k); return v === null ? dflt : JSON.parse(v); }
      catch (e) { return dflt; }
    },
    set: function (k, v) { try { localStorage.setItem('ppp.' + k, JSON.stringify(v)); } catch (e) {} }
  };

  /* ---------------------------------------------------------------- state */

  var S = {
    pairs: [],
    symbol: LS.get('symbol', 'BTCUSDT'),
    chartTf: LS.get('chartTf', '1h'),
    profile: LS.get('profile', E.DEFAULT_PROFILE),
    ctx: null,
    res: null,
    heat: null,
    backtest: null,
    busy: false,
    error: null,
    equity: LS.get('equity', 10000),
    riskPct: LS.get('riskPct', 1),
    leverage: LS.get('leverage', 5),
    watchlist: LS.get('watchlist', []),
    alertsOn: LS.get('alertsOn', false),
    lastVerdicts: LS.get('lastVerdicts', {}),
    scanning: false
  };

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  function fmtPrice(v) { return C.fmtPrice(v); }
  function fmtUsd(v, dp) {
    if (v === null || v === undefined || v === '') return '—';
    var n = typeof v === 'number' ? v : Number(v);
    if (!isFinite(n)) return '—';
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return '$' + n.toLocaleString(undefined, { maximumFractionDigits: dp === undefined ? 0 : dp });
    return '$' + n.toFixed(dp === undefined ? 2 : dp);
  }
  function fmtNum(v, dp) {
    if (v === null || v === undefined || v === '') return '—';
    var n = typeof v === 'number' ? v : Number(v);
    return isFinite(n) ? n.toFixed(dp === undefined ? 2 : dp) : '—';
  }
  function signed(v, dp) {
    var n = typeof v === 'number' ? v : Number(v);
    if (!isFinite(n)) return '—';
    return (n > 0 ? '+' : '') + fmtNum(n, dp);
  }
  function scoreClass(v) { return v > 0.05 ? 'up' : v < -0.05 ? 'down' : ''; }

  /* --------------------------------------------------------------- lookup */

  function pairMeta(sym) {
    for (var i = 0; i < S.pairs.length; i++) if (S.pairs[i].symbol === sym) return S.pairs[i];
    return null;
  }

  /* ------------------------------------------------------------ data load */

  function load(symbol) {
    S.busy = true; S.error = null;
    renderStatus('Loading ' + symbol + '…', '');
    return D.loadContext(symbol).then(function (ctx) {
      S.ctx = ctx;
      S.res = E.analyze(ctx, analysisOpts());
      S.heat = buildHeatmap(ctx);
      S.backtest = null;
      S.busy = false;
      renderAll();
      startStream();
      trackVerdict();
    }).catch(function (e) {
      S.busy = false;
      S.error = e && e.message ? e.message : String(e);
      renderStatus('Failed to load ' + symbol, 'err');
      renderAll();
    });
  }

  function analysisOpts() {
    return {
      interval: '1h', weights: S.profile,
      equity: S.equity, riskPct: S.riskPct, leverage: S.leverage,
      feePct: 0.035, slipPct: 0.02
    };
  }

  function reanalyze() {
    if (!S.ctx) return;
    S.res = E.analyze(S.ctx, analysisOpts());
    renderVerdict(); renderFactors(); renderPlan(); renderDerivatives();
  }

  /* ------------------------------------------------------------- heatmap */

  /* Per-timeframe read. Deliberately a compact independent computation rather
   * than 4 full engine runs, so the grid stays cheap and legible. */
  function buildHeatmap(ctx) {
    var out = {};
    ['15m', '1h', '4h', '1d'].forEach(function (tf) {
      var bars = ctx.bars[tf];
      if (!bars || bars.length < 60) { out[tf] = null; return; }
      var p = E.prep(bars);
      var i = p.n - 1, c = p.c[i];
      var e20 = p.ema20[i], e50 = p.ema50[i], e200 = p.ema200[i];
      var trend = 0, cnt = 0;
      if (e20 !== null) { trend += c > e20 ? 1 : -1; cnt++; }
      if (e50 !== null && e20 !== null) { trend += e20 > e50 ? 1 : -1; cnt++; }
      if (e200 !== null && e50 !== null) { trend += e50 > e200 ? 1 : -1; cnt++; }
      trend = cnt ? trend / cnt : 0;
      var rsi = p.rsi14[i];
      var mom = rsi === null ? 0 : I.scale(rsi, 38, 62);
      var macdH = p.macd.hist[i], atrV = p.atr14[i];
      var macdS = (macdH === null || !atrV) ? 0 : I.clamp((macdH / atrV) * 2, -1, 1);
      var adxV = p.adx.adx[i], pd = p.adx.plusDI[i], md = p.adx.minusDI[i];
      var dir = (pd !== null && md !== null && (pd + md)) ? (pd - md) / (pd + md) : 0;
      var adxS = adxV === null ? 0 : dir * Math.min(1, adxV / 40);
      out[tf] = {
        trend: trend, momentum: mom, macd: macdS, adx: adxS,
        adxRaw: adxV, rsi: rsi, price: c, close: c
      };
    });
    return out;
  }

  /* --------------------------------------------------------- watch + alert */

  function trackVerdict() {
    if (!S.res || !S.res.ok) return;
    var prev = S.lastVerdicts[S.symbol];
    var now = S.res.verdict;
    if (prev && prev !== now && prev !== 'NO TRADE' && now !== 'NO TRADE' && S.alertsOn) {
      notify('PCS-Perp-Predict — ' + S.symbol, 'Signal flipped from ' + prev + ' to ' + now +
        ' (composite ' + S.res.composite + ').');
    }
    if (prev !== now) { S.lastVerdicts[S.symbol] = now; LS.set('lastVerdicts', S.lastVerdicts); }
  }

  function notify(title, body) {
    try {
      if (typeof Notification === 'undefined') return;
      if (Notification.permission === 'granted') new Notification(title, { body: body });
    } catch (e) {}
  }

  /* ------------------------------------------------------------- rendering */

  function renderAll() {
    renderStatus();
    renderVerdict();
    renderChart();
    renderHeatmap();
    renderFactors();
    renderDerivatives();
    renderPlan();
    renderSizing();
    renderWatchlist();
    renderValidation();
    renderBacktest();
  }

  function renderStatus(text, cls) {
    var dot = $('statusDot'), t = $('statusText'), up = $('lastUpdate');
    if (text) {
      dot.className = 'status-dot ' + (cls || '');
      t.textContent = text;
    } else {
      dot.className = 'status-dot ' + (S.error ? 'err' : 'live');
      t.textContent = S.error ? ('Error: ' + S.error) : ('Live — Aster fapi · ' + S.symbol + ' · signal on 1h');
    }
    if (S.ctx) up.textContent = 'updated ' + new Date(S.ctx.loadedAt).toLocaleTimeString();
  }

  function renderVerdict() {
    var el = $('verdictCard');
    var r = S.res;
    if (S.busy) { el.innerHTML = '<div class="card verdict-card"><h2>Verdict</h2><div style="display:flex;gap:10px;align-items:center;color:var(--text2)"><span class="spinner"></span> Analysing…</div></div>'; return; }
    if (S.error) { el.innerHTML = '<div class="card verdict-card"><h2>Verdict</h2><div class="err">' + esc(S.error) + '</div></div>'; return; }
    if (!r || !r.ok) {
      el.innerHTML = '<div class="card verdict-card"><h2>Verdict</h2><div class="err">' + esc(r && r.error ? r.error : 'No analysis') + '</div></div>';
      return;
    }

    var side = r.verdict === 'NO TRADE' ? 'none' : r.verdict.toLowerCase();
    var meta = pairMeta(r.symbol);
    var tick = S.ctx && S.ctx.deriv ? S.ctx.deriv.ticker : {};
    var chg = tick.priceChangePercent !== undefined ? parseFloat(tick.priceChangePercent) : null;

    var html = '';
    html += '<div class="card verdict-card ' + side + '">';
    html += '<h2>Verdict <span class="tag">' + esc(r.profile) + ' weights</span><span class="right">composite model · 22 factors</span></h2>';
    html += '<div class="verdict-head">';
    html += '<div class="verdict-side ' + side + '">' + (r.verdict === 'NO TRADE' ? 'NO TRADE' : r.verdict) + '</div>';
    html += '<div class="verdict-meta">';
    html += '<span class="sym">' + esc(r.symbol) + '</span>';
    html += '<span class="px">' + fmtPrice(r.price) + ' USDT' + (chg !== null ? ' · 24h <b class="' + (chg >= 0 ? 'up' : 'down') + '" style="color:' + (chg >= 0 ? 'var(--up)' : 'var(--down)') + '">' + signed(chg, 2) + '%</b>' : '') + '</span>';
    html += '<div style="display:flex;gap:6px;margin-top:5px;flex-wrap:wrap">';
    html += '<span class="pill ' + (r.tier === 'HIGH' ? 'high' : r.tier === 'MEDIUM' ? 'medium' : r.tier === 'LOW' ? 'low' : 'none') + '">' + (r.tier === 'NONE' ? 'no position' : r.tier + ' conviction') + '</span>';
    html += '<span class="pill">agreement ' + (r.agreement * 100).toFixed(0) + '%</span>';
    html += '<span class="pill">coverage ' + (r.coverage * 100).toFixed(0) + '%</span>';
    html += '</div></div>';
    html += '<div class="verdict-meta" style="margin-left:auto;text-align:right">';
    html += '<span class="px">24h volume ' + fmtUsd(tick.quoteVolume) + '</span>';
    html += '<span class="px">ATR ' + fmtNum(r.atrPct, 3) + '%/1h</span>';
    html += '<span class="px">mark ' + fmtPrice(S.ctx.deriv.markPrice) + '</span>';
    html += '</div></div>';

    /* composite gauge, -100..+100 with the no-trade band drawn in */
    var pct = Math.max(-100, Math.min(100, r.composite));
    var bandPct = E.CFG.minComposite;
    html += '<div class="gauge">';
    html += '<div class="gauge-bar">';
    html += '<div class="gauge-band" style="left:' + (50 - bandPct / 2) + '%;width:' + bandPct + '%"></div>';
    html += '<div class="gauge-mid"></div>';
    var w = Math.abs(pct) / 2;
    html += '<div class="gauge-fill ' + (pct >= 0 ? 'long' : 'short') + '" style="' + (pct >= 0 ? 'left:50%;' : 'right:50%;') + 'width:' + w + '%"></div>';
    html += '<div class="gauge-needle" style="left:calc(' + (50 + pct / 2) + '% - 1.5px)"></div>';
    html += '</div>';
    html += '<div class="gauge-scale"><span>-100 short</span><span>±' + bandPct + ' no-trade band</span><span>long +100</span></div>';
    html += '</div>';

    html += '<div class="metrics">';
    html += metric('Composite', signed(r.composite, 1), r.composite > 0 ? 'up' : r.composite < 0 ? 'down' : '');
    html += metric('Confidence', fmtNum(r.confidence, 0) + '%', r.confidence >= 60 ? 'up' : '');
    html += metric('Volatility', fmtNum(r.atrPct, 3) + '%', '', true);
    html += metric('Funding 8h', (S.ctx.deriv.lastFundingRate !== null ? signed(S.ctx.deriv.lastFundingRate * 100, 4) + '%' : '—'), (S.ctx.deriv.lastFundingRate || 0) > 0 ? 'down' : 'up', true);
    html += metric('Open interest', S.ctx.deriv.openInterest !== null ? fmtNum(S.ctx.deriv.openInterest, 0) : '—', '', true);
    html += '</div>';

    if (r.blockers && r.blockers.length) {
      html += '<div class="blockers">';
      r.blockers.forEach(function (b) {
        html += '<div class="blocker"><span class="bc">' + esc(b.code || 'GATE') + '</span><span>' + esc(b.text) + '</span></div>';
      });
      html += '</div>';
    }
    if (r.notes && r.notes.length) {
      html += '<div class="notes">';
      r.notes.forEach(function (n) { html += '<div class="note"><span class="nc">i</span><span>' + esc(n) + '</span></div>'; });
      html += '</div>';
    }

    html += edgeStrip(r.profile);
    html += '</div>';
    el.innerHTML = html;
  }

  function metric(k, v, cls, small) {
    return '<div class="metric"><div class="k">' + esc(k) + '</div><div class="v ' + (cls || '') + (small ? ' small' : '') + '">' + v + '</div></div>';
  }

  /* The honesty strip. Always states what the active weight profile actually
   * measured, so a verdict can never be mistaken for a demonstrated edge. */
  function edgeStrip(profile) {
    var oos = V.oos && V.oos.sets ? V.oos.sets : null;
    var html = '<div class="edge-strip">';
    if (oos && oos.test && oos.test.profiles && oos.test.profiles[profile]) {
      var t = oos.test.profiles[profile], f = oos.fit.profiles[profile];
      var word = t.tStatistic >= 1.96 ? 'statistically significant' : 'NOT statistically significant (|t| &lt; 2)';
      html += '<b>What the ' + esc(E.PROFILE_LABELS[profile] || profile) + ' profile actually measured.</b> On ' +
        oos.test.symbols.length + ' symbols the weights never saw it produced <b>' + t.trades + ' trades</b>, ' +
        '<b>' + signed(t.avgR, 3) + 'R</b> per trade, profit factor <b>' + fmtNum(t.profitFactor, 2) +
        '</b>, max drawdown <b>' + fmtNum(t.maxDrawdownPct, 1) + '%</b>, t = ' + fmtNum(t.tStatistic, 2) +
        ' — <span class="warn">' + word + '</span>.';
      if (f && f.trades) {
        html += ' In-sample (' + oos.fit.symbols.length + ' symbols) the same profile gave ' + signed(f.avgR, 3) + 'R over ' + f.trades + ' trades.';
      }
    } else {
      html += '<b>Measured expectancy unavailable.</b> Regenerate it with <span class="mono">node scripts/oos_test.mjs</span>.';
    }
    html += '<br><b>Both data-fitted weightings in this build failed on held-out symbols, so the default is the unfitted design prior.</b> ' +
      'Treat the verdict as a structured summary of current conditions, not a forecast — costs alone run about 0.09R per trade, and nothing here has demonstrated an edge that clears them.</div>';
    return html;
  }

  function renderChart() {
    var el = $('chartCard');
    if (!S.ctx) return;
    var bars = S.ctx.bars[S.chartTf];
    if (!bars || !bars.length) { el.innerHTML = '<div class="card"><h2>Price action</h2><div class="err">No data for ' + esc(S.chartTf) + '</div></div>'; return; }

    var p = E.prep(bars);
    var html = '<div class="card"><h2>Price action <span class="tag">' + esc(S.chartTf) + '</span>';
    html += '<span class="right">' + bars.length + ' bars · last ' + Math.min(160, bars.length) + ' shown</span></h2>';
    html += '<div class="tf-toggle" id="chartTfToggle">';
    ['15m', '1h', '4h', '1d'].forEach(function (tf) {
      html += '<button data-tf="' + tf + '" class="' + (tf === S.chartTf ? 'active' : '') + '">' + tf + '</button>';
    });
    html += '<label style="margin-left:auto;font-size:11px;color:var(--text3);display:flex;align-items:center;gap:6px">';
    html += '<input type="checkbox" id="showBB" ' + (LS.get('showBB', true) ? 'checked' : '') + '> Bollinger</label>';
    html += '<label style="font-size:11px;color:var(--text3);display:flex;align-items:center;gap:6px">';
    html += '<input type="checkbox" id="showVwap" ' + (LS.get('showVwap', false) ? 'checked' : '') + '> VWAP</label>';
    html += '</div>';
    html += '<div class="legend">';
    html += '<span><i style="background:' + C.THEME.ema20 + '"></i>EMA20</span>';
    html += '<span><i style="background:' + C.THEME.ema50 + '"></i>EMA50</span>';
    html += '<span><i style="background:' + C.THEME.ema200 + '"></i>EMA200</span>';
    if (S.res && S.res.plan) {
      html += '<span><i style="background:' + C.THEME.entry + '"></i>Entry ' + fmtPrice(S.res.plan.entry) + '</span>';
      html += '<span><i style="background:' + C.THEME.stop + '"></i>Stop ' + fmtPrice(S.res.plan.stop) + '</span>';
      html += '<span><i style="background:' + C.THEME.tp + '"></i>Targets</span>';
    }
    html += '</div>';
    html += '<div class="chart-wrap"><canvas id="priceChart"></canvas></div></div>';
    el.innerHTML = html;

    C.drawPrice($('priceChart'), {
      bars: bars,
      series: { ema20: p.ema20, ema50: p.ema50, ema200: p.ema200, bb: p.bb, vwap: p.vwap20 },
      plan: S.res && S.res.plan ? S.res.plan : null,
      showBB: LS.get('showBB', true), showVwap: LS.get('showVwap', false),
      tail: 160, height: 340
    });

    $('chartTfToggle').addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-tf]');
      if (!b) return;
      S.chartTf = b.getAttribute('data-tf');
      LS.set('chartTf', S.chartTf);
      renderChart();
    });
    ['showBB', 'showVwap'].forEach(function (id) {
      var cb = $(id);
      if (!cb) return;
      cb.addEventListener('change', function () { LS.set(id, cb.checked); renderChart(); });
    });
  }

  function renderHeatmap() {
    var el = $('heatCard');
    if (!S.heat) { el.innerHTML = '<div class="card"><h2>Multi-timeframe</h2><div class="err">No data</div></div>'; return; }
    var tfs = ['15m', '1h', '4h', '1d'];
    var cell = function (v) {
      var t = Math.max(-1, Math.min(1, v));
      var bg = t >= 0 ? 'rgba(47,208,122,' + (0.10 + Math.abs(t) * 0.55) + ')' : 'rgba(255,93,108,' + (0.10 + Math.abs(t) * 0.55) + ')';
      return '<div class="heat-cell" style="background:' + bg + ';color:' + (Math.abs(t) > 0.45 ? '#fff' : 'var(--text2)') + '">' + (v >= 0 ? '+' : '') + v.toFixed(2) + '</div>';
    };
    var html = '<div class="card"><h2>Multi-timeframe read <span class="tag">independent of the 1h signal</span></h2>';
    html += '<div class="heat">';
    html += '<div class="heat-row head"><span></span><span>Trend</span><span>Momentum</span><span>MACD/ATR</span><span>ADX/DMI</span></div>';
    tfs.forEach(function (tf) {
      var h = S.heat[tf];
      html += '<div class="heat-row"><span style="color:var(--text2);font-family:ui-monospace,monospace">' + tf + '</span>';
      if (!h) { html += '<div class="heat-cell" style="grid-column:span 4;color:var(--text3)">no data</div>'; }
      else {
        html += cell(h.trend) + cell(h.momentum) + cell(h.macd) + cell(h.adx);
      }
      html += '</div>';
    });
    html += '</div>';
    html += '<div class="notes" style="margin-top:12px">';
    tfs.forEach(function (tf) {
      var h = S.heat[tf];
      if (!h) return;
      html += '<div class="note"><span class="nc">' + tf + '</span><span>RSI ' + fmtNum(h.rsi, 1) +
        ' · ADX ' + fmtNum(h.adxRaw, 1) + ' · close ' + fmtPrice(h.close) + '</span></div>';
    });
    html += '</div></div>';
    el.innerHTML = html;
  }

  function renderFactors() {
    var el = $('factorCard');
    var r = S.res;
    if (!r || !r.ok) { el.innerHTML = '<div class="card"><h2>Evidence</h2><div class="err">No analysis</div></div>'; return; }
    var html = '<div class="card"><h2>Evidence by facet <span class="tag">' + (r.profile === 'ic' ? 'IC weights · muted factors shown as context' : 'balanced weights') + '</span>';
    html += '<span class="right">' + r.groups.reduce(function (a, g) { return a + g.factors.length; }, 0) + ' factors</span></h2>';
    r.groups.forEach(function (g) {
      if (!g.factors.length) return;
      html += '<div class="group">';
      html += '<div class="group-head"><span class="gn">' + esc(g.id + ' · ' + g.name) + '</span>';
      html += '<span class="gw">w ' + fmtNum(g.weight, 2) + '</span>';
      html += '<span class="gs ' + scoreClass(g.score) + '" style="color:' + (g.score > 0.05 ? 'var(--up)' : g.score < -0.05 ? 'var(--down)' : 'var(--text2)') + '">' + signed(g.score, 2) + '</span></div>';
      html += '<div class="group-blurb">' + esc(g.blurb) + '</div>';
      g.factors.forEach(function (f) {
        var off = !f.available;
        html += '<div class="factor' + (off ? ' off' : '') + '">';
        html += '<div class="fname"><span class="fid">' + esc(f.id) + '</span>' + esc(f.name);
        if (f.mutedByProfile) html += '<span class="muted">context only</span>';
        html += '</div>';
        html += '<div class="fscore" style="color:' + (off ? 'var(--text3)' : f.score > 0.05 ? 'var(--up)' : f.score < -0.05 ? 'var(--down)' : 'var(--text3)') + '">' + (off ? 'off' : signed(f.score, 2)) + '</div>';
        html += '<div class="bar"><span class="' + (f.score >= 0 ? 'pos' : 'neg') + '" style="width:' + (Math.abs(f.score) * 50) + '%"></span></div>';
        html += '<div class="fdetail">' + esc(f.detail) + '</div>';
        html += '</div>';
      });
      html += '</div>';
    });
    if (r.contextFactors && r.contextFactors.length) {
      html += '<div class="group" style="margin-top:8px"><div class="group-head"><span class="gn">Higher-timeframe context</span><span class="gw">no vote</span></div>';
      r.contextFactors.forEach(function (f) {
        html += '<div class="factor"><div class="fname"><span class="fid">' + esc(f.id) + '</span>' + esc(f.name) + '</div>';
        html += '<div class="fscore" style="color:var(--text2)">' + signed(f.score, 2) + '</div>';
        html += '<div class="fdetail">' + esc(f.detail) + '</div></div>';
      });
      html += '</div>';
    }
    html += '</div>';
    el.innerHTML = html;
  }

  function renderDerivatives() {
    var el = $('derivCard');
    if (!S.ctx) return;
    var d = S.ctx.deriv, t = d.ticker || {};
    var fh = S.ctx.fundingHist || [];
    var rates = fh.map(function (x) { return parseFloat(x.fundingRate) * 100; });
    var pct = rates.length >= 5 ? I.percentileRank(rates) : null;
    var annual = d.lastFundingRate !== null && d.lastFundingRate !== undefined ? d.lastFundingRate * 3 * 365 * 100 : null;
    var basis = (d.markPrice && d.indexPrice) ? (d.markPrice - d.indexPrice) / d.indexPrice * 10000 : null;

    var html = '<div class="card"><h2>Derivatives context <span class="tag">PCS Perps venue</span></h2>';
    html += '<dl class="kv">';
    html += '<dt>Mark price</dt><dd>' + fmtPrice(d.markPrice) + '</dd>';
    html += '<dt>Index price</dt><dd>' + fmtPrice(d.indexPrice) + '</dd>';
    html += '<dt>Basis (mark − index)</dt><dd style="color:' + (basis > 0 ? 'var(--up)' : basis < 0 ? 'var(--down)' : '') + '">' + (basis === null ? '—' : signed(basis, 2) + ' bps') + '</dd>';
    html += '<dt>Funding rate (8h)</dt><dd>' + (d.lastFundingRate !== null && d.lastFundingRate !== undefined ? signed(d.lastFundingRate * 100, 4) + '%' : '—') + '</dd>';
    html += '<dt>Annualised funding</dt><dd>' + (annual === null ? '—' : signed(annual, 1) + '%') + '</dd>';
    html += '<dt>Funding percentile</dt><dd>' + (pct === null ? '—' : (pct * 100).toFixed(0) + 'th of ' + rates.length) + '</dd>';
    html += '<dt>Next funding</dt><dd>' + (d.nextFundingTime ? new Date(Number(d.nextFundingTime)).toLocaleString() : '—') + '</dd>';
    html += '<dt>Open interest</dt><dd>' + (d.openInterest === null ? '—' : fmtNum(d.openInterest, 0)) + '</dd>';
    html += '<dt>24h volume</dt><dd>' + fmtUsd(t.quoteVolume) + '</dd>';
    html += '<dt>24h range</dt><dd>' + fmtPrice(t.lowPrice) + ' – ' + fmtPrice(t.highPrice) + '</dd>';
    html += '</dl>';
    if (d.openInterest === null || !S.ctx.oiHist) {
      html += '<div class="notes" style="margin-top:10px"><div class="note"><span class="nc">i</span><span>Aster exposes a current open-interest snapshot but no history endpoint, so the open-interest-vs-price factor has no series to read here and its weight is redistributed.</span></div></div>';
    }
    if (rates.length > 5) {
      html += '<div class="chart-wrap" style="margin-top:12px"><canvas id="fundChart"></canvas></div>';
      html += '<div class="legend" style="margin-top:6px;margin-bottom:0"><span>Funding rate history — last ' + rates.length + ' intervals</span></div>';
    }
    html += '</div>';
    el.innerHTML = html;
    if (rates.length > 5) drawFunding($('fundChart'), rates);
  }

  function drawFunding(canvas, rates) {
    var dpr = window.devicePixelRatio || 1;
    var W = canvas.clientWidth || 400, H = 96;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.height = H + 'px';
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var lo = Math.min.apply(null, rates), hi = Math.max.apply(null, rates);
    if (hi === lo) { hi = lo + 0.0001; }
    var pad = (hi - lo) * 0.15; lo -= pad; hi += pad;
    var yOf = function (v) { return H - 8 - (v - lo) / (hi - lo) * (H - 16); };
    var bw = W / rates.length;
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.beginPath(); ctx.moveTo(0, yOf(0)); ctx.lineTo(W, yOf(0)); ctx.stroke();
    rates.forEach(function (v, i) {
      ctx.fillStyle = v >= 0 ? 'rgba(47,208,122,0.75)' : 'rgba(255,93,108,0.75)';
      var y0 = yOf(0), y1 = yOf(v);
      ctx.fillRect(i * bw + bw * 0.15, Math.min(y0, y1), Math.max(1, bw * 0.7), Math.max(1, Math.abs(y1 - y0)));
    });
    ctx.fillStyle = 'var(--text3)';
    ctx.font = '9px ui-monospace,monospace';
    ctx.fillStyle = '#6b6b85';
    ctx.fillText(signed(hi, 4) + '%', 4, 10);
    ctx.fillText(signed(lo, 4) + '%', 4, H - 3);
  }

  function renderPlan() {
    var el = $('planCard');
    var r = S.res;
    if (!r || !r.ok) { el.innerHTML = '<div class="card"><h2>Trade plan</h2><div class="err">No analysis</div></div>'; return; }
    if (!r.plan) {
      el.innerHTML = '<div class="card"><h2>Trade plan</h2><div class="notes"><div class="note"><span class="nc">—</span><span>No plan is generated while the verdict is NO TRADE. Levels are only drawn when every gate passes, because a stop and target on a signal that did not clear its own filters would be a fabricated level.</span></div></div></div>';
      return;
    }
    var pl = r.plan, pr = r.price;
    var pc = function (v) { return ((v - pr) / pr * 100); };
    var html = '<div class="card"><h2>Trade plan <span class="tag">' + esc(pl.side) + '</span>';
    html += '<span class="right">ATR-based stop · scaled targets</span></h2>';
    html += '<div class="plan-levels">';
    html += '<div class="plan-row entry"><span class="lbl">Entry</span><span>market</span><span class="px">' + fmtPrice(pl.entry) + '</span><span class="pct">' + signed(pc(pl.entry), 2) + '%</span></div>';
    html += '<div class="plan-row stop"><span class="lbl">Stop</span><span style="font-size:11.5px;color:var(--text2)">' + fmtNum(1.5, 1) + '×ATR / structure</span><span class="px">' + fmtPrice(pl.stop) + '</span><span class="pct">' + signed(pc(pl.stop), 2) + '%</span></div>';
    pl.targets.forEach(function (t, i) {
      var unreach = pl.attainableR < t.r;
      html += '<div class="plan-row tp' + (unreach ? ' unreachable' : '') + '"><span class="lbl">TP' + (i + 1) + ' ' + t.r + 'R</span><span style="font-size:11.5px;color:var(--text2)">' + Math.round(t.portion * 100) + '% out</span><span class="px">' + fmtPrice(t.price) + '</span><span class="pct">' + signed(pc(t.price), 2) + '%</span></div>';
    });
    html += '</div>';
    html += '<div class="metrics" style="margin-top:12px">';
    html += metric('Stop distance', fmtNum(pl.stopPct, 3) + '%', '', true);
    html += metric('Room to structure', pl.roomAtr === null ? 'open' : fmtNum(pl.roomAtr, 2) + ' ATR', '', true);
    html += metric('Attainable R', fmtNum(pl.attainableR, 2) + 'R', pl.attainableR >= 2 ? 'up' : 'down', true);
    html += metric('Blended R:R', fmtNum(pl.targets.reduce(function (a, t) { return a + t.r * t.portion; }, 0), 2) + ':1', 'up', true);
    html += '</div>';
    if (pl.warnings && pl.warnings.length) {
      html += '<div class="notes" style="margin-top:10px">';
      pl.warnings.forEach(function (w) { html += '<div class="note"><span class="nc">!</span><span>' + esc(w) + '</span></div>'; });
      html += '</div>';
    }
    html += '<div class="notes" style="margin-top:10px"><div class="note"><span class="nc">i</span><span>Targets beyond ' + fmtNum(pl.attainableR, 2) + 'R are marked unreachable — the next opposing structure sits before them.</span></div></div>';
    html += '</div>';
    el.innerHTML = html;
  }

  function renderSizing() {
    var el = $('sizeCard');
    var r = S.res;
    if (!r || !r.ok || !r.size) {
      el.innerHTML = '<div class="card"><h2>Position sizing</h2><div class="notes"><div class="note"><span class="nc">—</span><span>Sizing appears once a trade plan exists. Enter your account risk budget to see notional, margin and the leverage ceiling the stop distance supports.</span></div></div>' +
        '<div class="sizing">' +
        sizField('equity', 'Equity (USDT)', S.equity, 100, 'any') +
        sizField('riskPct', 'Risk per trade %', S.riskPct, 0.1, 'any') +
        sizField('leverage', 'Leverage ×', S.leverage, 1, 'any') +
        '</div></div>';
      bindSizing(); return;
    }
    var sz = r.size;
    var html = '<div class="card"><h2>Position sizing <span class="tag">risk-first</span></h2>';
    html += '<div class="sizing">' + sizField('equity', 'Equity (USDT)', S.equity, 100, 'any') + sizField('riskPct', 'Risk per trade %', S.riskPct, 0.1, 'any') + sizField('leverage', 'Leverage ×', S.leverage, 1, 'any') + '</div>';
    html += '<div class="metrics" style="margin-top:12px">';
    html += metric('Risk budget', fmtUsd(sz.riskUsd, 2), '', true);
    html += metric('Position size', fmtNum(sz.qty, 6) + ' ' + esc((pairMeta(r.symbol) || {}).base || ''), '', true);
    html += metric('Notional', fmtUsd(sz.notional, 0), '', true);
    html += metric('Margin required', fmtUsd(sz.margin, 0), '', true);
    html += metric('Est. costs', fmtUsd(sz.feesUsd, 2), '', true);
    html += metric('Loss at stop', fmtUsd(sz.lossAtStopWithCostsUsd, 2), 'down', true);
    html += metric('Gain at final TP', fmtUsd(sz.totalAtFinalTargetUsd, 2), 'up', true);
    html += metric('Liquidation', fmtPrice(sz.liquidationPrice), sz.stopIsSafe ? '' : 'down', true);
    html += metric('Max safe leverage', sz.maxSafeLeverage + '×', S.leverage > sz.maxSafeLeverage ? 'down' : 'up', true);
    html += '</div>';
    if (!sz.stopIsSafe) {
      html += '<div class="blockers"><div class="blocker"><span class="bc">LIQ</span><span>At ' + sz.leverage + '× the liquidation price (' + fmtPrice(sz.liquidationPrice) + ') sits inside your stop (' + fmtPrice(r.plan.stop) + '). Liquidation would fire before the stop. Reduce leverage to ' + sz.maxSafeLeverage + '× or tighter.</span></div></div>';
    } else {
      html += '<div class="notes" style="margin-top:10px"><div class="note"><span class="nc">i</span><span>Liquidation at ' + fmtPrice(sz.liquidationPrice) + ' is ' + fmtNum(sz.liquidationDistance / r.plan.stopDist, 1) + '× further away than the stop, so the stop should always trigger first.</span></div></div>';
    }
    html += '</div>';
    el.innerHTML = html;
    bindSizing();
  }

  function sizField(id, label, val, step, min) {
    return '<div class="metric"><div class="k">' + esc(label) + '</div><input type="number" id="sz_' + id + '" value="' + val + '" step="' + step + '" min="' + min + '" style="width:100%;margin-top:4px;font-size:14px;font-weight:700"></div>';
  }

  function bindSizing() {
    [['sz_equity', 'equity', 'equity'], ['sz_riskPct', 'riskPct', 'riskPct'], ['sz_leverage', 'leverage', 'leverage']].forEach(function (triple) {
      var el = $(triple[0]);
      if (!el) return;
      el.addEventListener('change', function () {
        var v = parseFloat(el.value);
        if (isNaN(v) || v <= 0) return;
        S[triple[1]] = v;
        LS.set(triple[2], v);
        reanalyze(); renderSizing();
      });
    });
  }

  /* ---------------------------------------------------------- validation */

  function renderValidation() {
    var el = $('validCard');
    var ic = V.ic, oos = V.oos;
    var html = '<div class="card"><h2>Model validation <span class="tag">measured, not asserted</span></h2>';
    if (!ic || !ic.factors) {
      html += '<div class="notes"><div class="note"><span class="nc">—</span><span>Validation data not baked into this build. Generate it with <span class="mono">node scripts/ic_study.mjs</span> and <span class="mono">node scripts/oos_test.mjs</span>, then rebuild.</span></div></div></div>';
      el.innerHTML = html; return;
    }
    html += '<div class="notes" style="margin-bottom:12px">';
    html += '<div class="note"><span class="nc">i</span><span><b>Information coefficient</b> = correlation between a factor&rsquo;s score at bar t and the forward return. ' + ic.samples.toLocaleString() + ' samples across ' + ic.symbols.length + ' symbols. |t| &lt; 2 is indistinguishable from noise.</span></div>';
    html += '</div>';

    var mainH = ic.horizons[Math.min(1, ic.horizons.length - 1)];
    var rows = ic.factors.slice().sort(function (a, b) { return Math.abs(b.horizons[mainH].ic) - Math.abs(a.horizons[mainH].ic); });
    html += '<table><thead><tr><th>Factor</th><th>Weight</th>' + ic.horizons.map(function (h) { return '<th>IC ' + h + 'h</th>'; }).join('') + '<th>t</th><th>Verdict</th></tr></thead><tbody>';
    rows.forEach(function (f) {
      var w = E.WEIGHTS[S.profile][f.id];
      var r = f.horizons[mainH];
      var label = Math.abs(r.t) < 2 ? 'noise' : (r.ic > 0 ? 'predictive' : 'contrarian');
      html += '<tr><td><span class="mono" style="color:var(--text3);font-size:10px">' + esc(f.id) + '</span> ' + esc(f.name.replace(/ \(1h\)| \(4h\)| \(1d\)/, '')) + '</td>';
      html += '<td class="mono" style="color:' + (w === 0 ? 'var(--text3)' : 'var(--text)') + '">' + (w === 0 ? 'muted' : fmtNum(w, 2)) + '</td>';
      ic.horizons.forEach(function (h) {
        var v = f.horizons[h].ic;
        html += '<td class="mono ' + (Math.abs(f.horizons[h].t) >= 2 ? (v > 0 ? 'up' : 'down') : '') + '">' + signed(v, 3) + '</td>';
      });
      html += '<td class="mono ' + (Math.abs(r.t) >= 2 ? (r.ic > 0 ? 'up' : 'down') : '') + '">' + fmtNum(r.t, 2) + '</td>';
      html += '<td style="color:var(--text3)">' + label + '</td></tr>';
    });
    html += '<tr style="border-top:2px solid var(--border)"><td><b>Weighted composite</b></td><td class="mono">1.00</td>';
    ic.horizons.forEach(function (h) {
      var v = ic.composite.horizons[h];
      html += '<td class="mono ' + (Math.abs(v.t) >= 2 ? (v.ic > 0 ? 'up' : 'down') : '') + '">' + signed(v.ic, 3) + '</td>';
    });
    html += '<td class="mono">' + fmtNum(ic.composite.horizons[mainH].t, 2) + '</td><td style="color:var(--text3)">' + (Math.abs(ic.composite.horizons[mainH].t) < 2 ? 'noise' : 'signal') + '</td></tr>';
    html += '</tbody></table>';

    if (oos && oos.sets) {
      html += '<h2 style="margin-top:20px">Out-of-sample walk-forward <span class="tag">costs charged</span></h2>';
      html += '<table><thead><tr><th>Symbol set</th><th>Weights</th><th>Trades</th><th>Win rate</th><th>Avg R</th><th>Profit factor</th><th>Max DD</th><th>t</th></tr></thead><tbody>';
      ['fit', 'test'].forEach(function (set) {
        Object.keys(oos.sets.fit.profiles).forEach(function (prof) {
          var s = oos.sets[set].profiles[prof];
          if (!s || !s.trades) return;
          var isTest = set === 'test';
          html += '<tr' + (isTest ? ' style="background:rgba(74,158,255,.05)"' : '') + '>';
          html += '<td>' + (isTest ? '<b>held out</b>' : 'fit set') + '</td>';
          html += '<td>' + esc(E.PROFILE_LABELS[prof] || prof) + (prof === S.profile ? ' <span class="pill low" style="padding:1px 5px">active</span>' : '') + '</td>';
          html += '<td class="mono">' + s.trades + '</td>';
          html += '<td class="mono">' + fmtNum(s.winRate, 1) + '%</td>';
          html += '<td class="mono ' + (s.avgR > 0 ? 'up' : 'down') + '">' + signed(s.avgR, 3) + '</td>';
          html += '<td class="mono">' + fmtNum(s.profitFactor, 2) + '</td>';
          html += '<td class="mono">' + fmtNum(s.maxDrawdownPct, 1) + '%</td>';
          html += '<td class="mono">' + fmtNum(s.tStatistic, 2) + '</td></tr>';
        });
      });
      html += '</tbody></table>';
      html += '<div class="notes" style="margin-top:10px">';
      (oos.method ? [oos.method.note] : []).forEach(function (n) { html += '<div class="note"><span class="nc">i</span><span>' + esc(n) + '</span></div>'; });
      html += '<div class="note"><span class="nc">!</span><span>Two independent reweighting rules were fitted and both land on <b>worse</b> held-out numbers than the unfitted prior. That is the central result of this project: with this factor set there is no reliable edge to extract, and a confidently-presented signal would be misleading. The app therefore defaults to the unfitted prior and shows you this table.</span></div>';
      html += '</div>';
    }

    if (V.calibration && V.calibration.ladders) {
      html += '<h2 style="margin-top:20px">Exit policy comparison <span class="tag">identical signals</span></h2>';
      html += '<table><thead><tr><th>Exit policy</th><th>Trades</th><th>Win rate</th><th>Avg R</th><th>PF</th><th>Max DD</th><th>t</th></tr></thead><tbody>';
      V.calibration.ladders.forEach(function (l) {
        var s = l.stats;
        if (!s || !s.trades) return;
        var best = (V.calibration.baseLadder && s.avgR === V.calibration.baseLadder.avgR);
        html += '<tr' + (best ? ' style="background:rgba(240,185,11,.06)"' : '') + '><td>' + esc(l.label) + (best ? ' <span class="pill medium" style="padding:1px 5px">default</span>' : '') + '</td>';
        html += '<td class="mono">' + s.trades + '</td><td class="mono">' + fmtNum(s.winRate, 1) + '%</td>';
        html += '<td class="mono ' + (s.avgR > 0 ? 'up' : 'down') + '">' + signed(s.avgR, 3) + '</td>';
        html += '<td class="mono">' + fmtNum(s.profitFactor, 2) + '</td><td class="mono">' + fmtNum(s.maxDrawdownPct, 1) + '%</td>';
        html += '<td class="mono">' + fmtNum(s.tStatistic, 2) + '</td></tr>';
      });
      html += '</tbody></table>';
      html += '<div class="notes" style="margin-top:10px"><div class="note"><span class="nc">i</span><span>Taking the first target all-out is the worst policy tested. Scaling out and letting winners run to 3R+ scores better on the same signals — which is why the default ladder keeps a 25% runner.</span></div></div>';
    }
    html += '</div>';
    el.innerHTML = html;
  }

  /* ------------------------------------------------------------ backtest */

  function renderBacktest() {
    var el = $('btCard');
    var html = '<div class="card"><h2>Walk-forward backtest <span class="tag">this symbol</span></h2>';
    html += '<div class="notes" style="margin-bottom:10px"><div class="note"><span class="nc">i</span><span>Replays the exact engine over the last N hourly bars using only closed data at each step. If a bar contains both the stop and a target, the stop is assumed to fill first.</span></div></div>';
    html += '<div class="controls" style="margin-bottom:12px;padding:10px">';
    html += '<div class="field"><label>Bars to evaluate</label><input type="number" id="btBars" value="' + LS.get('btBars', 400) + '" min="100" max="900" step="50"></div>';
    html += '<div class="field"><label>Weights</label><select id="btProfile">' +
      Object.keys(E.WEIGHTS).map(function (k) {
        return '<option value="' + k + '"' + (S.profile === k ? ' selected' : '') + '>' + esc(E.PROFILE_LABELS[k] || k) + '</option>';
      }).join('') + '</select></div>';
    html += '<button class="primary" id="btRun"' + (S.busy || !S.ctx ? ' disabled' : '') + '>Run backtest</button>';
    html += '</div>';

    if (!S.backtest) {
      html += '<div class="notes"><div class="note"><span class="nc">—</span><span>Not run yet. Cross-market results are in the Model validation panel; this runs the same engine on the symbol you are looking at.</span></div></div>';
    } else if (!S.backtest.ok) {
      html += '<div class="err">' + esc(S.backtest.error) + '</div>';
    } else {
      var st = S.backtest.stats;
      html += '<div class="metrics">';
      html += metric('Signals', S.backtest.signalCount, '', true);
      html += metric('Trades taken', st.trades, '', true);
      html += metric('Win rate', fmtNum(st.winRate, 1) + '%', st.winRate >= 50 ? 'up' : 'down', true);
      html += metric('Avg R', signed(st.avgR, 3), st.avgR > 0 ? 'up' : 'down', true);
      html += metric('Expectancy', signed(st.expectancyR, 3) + 'R', st.expectancyR > 0 ? 'up' : 'down', true);
      html += metric('Profit factor', fmtNum(st.profitFactor, 2), st.profitFactor >= 1 ? 'up' : 'down', true);
      html += metric('Total R', signed(st.totalR, 1), st.totalR > 0 ? 'up' : 'down', true);
      html += metric('Max drawdown', fmtNum(st.maxDrawdownPct, 1) + '%', '', true);
      html += metric('Worst streak', st.worstLosingStreak, '', true);
      html += metric('Avg bars held', fmtNum(st.avgBarsHeld, 1), '', true);
      html += metric('Cost drag', fmtNum(st.avgCostR, 3) + 'R', 'down', true);
      html += metric('Long / short', st.longs + ' / ' + st.shorts, '', true);
      html += '</div>';
      html += '<div class="chart-wrap" style="margin-top:14px"><canvas id="btEquity"></canvas></div>';
      html += '<div class="legend" style="margin-top:6px"><span>Equity curve at ' + fmtNum(S.riskPct, 2) + '% risk per trade, starting from ' + fmtUsd(S.equity, 0) + '</span></div>';
      html += '<div class="notes" style="margin-top:10px">';
      html += '<div class="note"><span class="nc">i</span><span>Buy &amp; hold over the same window: <b class="' + (st.buyHoldPct > 0 ? 'up' : 'down') + '" style="color:' + (st.buyHoldPct > 0 ? 'var(--up)' : 'var(--down)') + '">' + signed(st.buyHoldPct, 1) + '%</b>. Exits: ' +
        Object.keys(st.byReason).map(function (k) { return k + ' ' + st.byReason[k]; }).join(', ') + '.</span></div>';
      html += '<div class="note"><span class="nc">!</span><span>One symbol and one window is a sample of one regime. Read the held-out cross-market table before drawing conclusions.</span></div>';
      html += '</div>';
    }
    html += '</div>';
    el.innerHTML = html;

    var runBtn = $('btRun');
    if (runBtn) runBtn.addEventListener('click', runBacktest);
    var bp = $('btProfile');
    if (bp) bp.addEventListener('change', function () { S.profile = bp.value; LS.set('profile', S.profile); renderProfileToggle(); reanalyze(); });
    if (S.backtest && S.backtest.ok) {
      C.drawEquity($('btEquity'), S.backtest.stats.equityCurve);
    }
  }

  function runBacktest() {
    if (!S.ctx) return;
    var btn = $('btRun');
    if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
    var bars = parseInt(($('btBars') || {}).value || '400', 10);
    LS.set('btBars', bars);
    var prof = ($('btProfile') || {}).value || S.profile;

    /* Yield a frame so the button state paints before the synchronous replay. */
    setTimeout(function () {
      try {
        S.backtest = B.run(S.ctx, { bars: bars, warmup: 300, weights: prof, equity: S.equity, riskPct: S.riskPct });
      } catch (e) {
        S.backtest = { ok: false, error: e && e.message ? e.message : String(e) };
      }
      renderBacktest();
    }, 40);
  }

  /* ------------------------------------------------------------ watchlist */

  function renderWatchlist() {
    var el = $('watchCard');
    var html = '<div class="card"><h2>Watchlist <span class="tag">local</span>';
    html += '<span class="right">' + S.watchlist.length + ' saved</span></h2>';
    html += '<div class="controls" style="margin-bottom:10px;padding:10px">';
    html += '<button class="primary" id="wlScan"' + (S.scanning || !S.watchlist.length ? ' disabled' : '') + '>' + (S.scanning ? 'Scanning…' : 'Scan all') + '</button>';
    html += '<button class="ghost" id="wlToggle">' + (S.watchlist.indexOf(S.symbol) === -1 ? '★ Watch ' + S.symbol : '★ Unwatch ' + S.symbol) + '</button>';
    html += '<label style="font-size:11.5px;color:var(--text2);display:flex;align-items:center;gap:6px;margin-left:auto">';
    html += '<input type="checkbox" id="wlAlerts" ' + (S.alertsOn ? 'checked' : '') + '> Browser alerts on signal flips</label>';
    html += '</div>';
    if (!S.watchlist.length) {
      html += '<div class="notes"><div class="note"><span class="nc">—</span><span>Nothing saved. Hit <b>Watch</b> to add the current symbol, then <b>Scan all</b> to run the engine across the list.</span></div></div>';
    } else {
      S.watchlist.forEach(function (sym) {
        var row = S.watchRows && S.watchRows[sym];
        html += '<div class="watch-row"><span class="s">' + esc(sym) + '</span>';
        if (row === undefined) html += '<span style="color:var(--text3)">not scanned</span>';
        else if (row === null) html += '<span style="color:var(--down)">failed</span>';
        else if (!row.ok) html += '<span style="color:var(--down)">' + esc(row.error || 'error') + '</span>';
        else {
          html += '<span class="pill ' + (row.tier === 'HIGH' ? 'high' : row.tier === 'MEDIUM' ? 'medium' : row.tier === 'LOW' ? 'low' : 'none') + '">' + esc(row.verdict) + '</span>';
          html += '<span style="color:var(--text3);font-size:11px">agr ' + (row.agreement * 100).toFixed(0) + '% · ATX ' + fmtNum(row.atrPct, 2) + '%</span>';
          html += '<span class="v" style="color:' + (row.composite > 0 ? 'var(--up)' : 'var(--down)') + '">' + signed(row.composite, 1) + '</span>';
        }
        html += '<button class="ghost" data-open="' + esc(sym) + '">open</button>';
        html += '<button class="ghost" data-del="' + esc(sym) + '">×</button>';
        html += '</div>';
      });
    }
    html += '</div>';
    el.innerHTML = html;

    $('wlToggle').addEventListener('click', function () {
      var i = S.watchlist.indexOf(S.symbol);
      if (i === -1) S.watchlist.push(S.symbol); else S.watchlist.splice(i, 1);
      LS.set('watchlist', S.watchlist);
      renderWatchlist();
    });
    var al = $('wlAlerts');
    al.addEventListener('change', function () {
      S.alertsOn = al.checked; LS.set('alertsOn', S.alertsOn);
      if (S.alertsOn && typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission();
      }
    });
    var scan = $('wlScan');
    if (scan) scan.addEventListener('click', scanWatchlist);
    el.querySelectorAll('[data-open]').forEach(function (b) {
      b.addEventListener('click', function () { selectSymbol(b.getAttribute('data-open')); });
    });
    el.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        S.watchlist = S.watchlist.filter(function (s) { return s !== b.getAttribute('data-del'); });
        LS.set('watchlist', S.watchlist); renderWatchlist();
      });
    });
  }

  /* Sequential rather than parallel: 6-10 symbols at once would hammer the same
   * public endpoint and risk rate limiting for no real speed benefit. */
  function scanWatchlist() {
    S.scanning = true; S.watchRows = {};
    renderWatchlist();
    var queue = S.watchlist.slice();
    var step = function () {
      if (!queue.length) {
        S.scanning = false; renderWatchlist(); trackVerdict();
        return;
      }
      var sym = queue.shift();
      D.loadContext(sym).then(function (ctx) {
        var r = E.analyze(ctx, analysisOpts());
        S.watchRows[sym] = r.ok ? {
          ok: true, verdict: r.verdict, tier: r.tier, composite: r.composite,
          agreement: r.agreement, atrPct: r.atrPct
        } : { ok: false, error: r.error };
        var prev = S.lastVerdicts[sym];
        if (prev && prev !== r.verdict && prev !== 'NO TRADE' && r.verdict !== 'NO TRADE' && S.alertsOn) {
          notify('PCS-Perp-Predict — ' + sym, 'Signal flipped from ' + prev + ' to ' + r.verdict + '.');
        }
        S.lastVerdicts[sym] = r.verdict;
        LS.set('lastVerdicts', S.lastVerdicts);
      }).catch(function () {
        S.watchRows[sym] = null;
      }).then(function () {
        renderWatchlist();
        setTimeout(step, 120);
      });
    };
    step();
  }

  /* ---------------------------------------------------------- pair picker */

  function renderPicker() {
    var el = $('picker');
    el.innerHTML = '<div class="field grow combo"><label>Trading pair — ' + S.pairs.length + ' perpetuals on PCS Perps</label>' +
      '<input type="text" id="pairInput" autocomplete="off" value="' + esc(S.symbol) + '" placeholder="Search BTC, ETH, SOL…">' +
      '<div class="combo-list" id="comboList"></div></div>' +
      '<div class="field"><label>Weights</label><div class="seg" id="profSeg">' +
      Object.keys(E.WEIGHTS).map(function (k) {
        return '<button data-p="' + k + '" class="' + (k === S.profile ? 'active' : '') + '" title="' + esc(E.PROFILE_LABELS[k] || k) + '">' + esc(k) + '</button>';
      }).join('') +
      '</div></div>' +
      '<button class="primary" id="reloadBtn">Refresh</button>';

    var input = $('pairInput'), list = $('comboList');
    var render = function (q) {
      var query = (q || '').toUpperCase().trim();
      var matches = S.pairs.filter(function (p) {
        return !query || p.symbol.indexOf(query) !== -1 || p.base.indexOf(query) !== -1;
      });
      if (!query) matches = D.sortForDropdown(matches).slice(0, 60);
      else matches = matches.slice(0, 80);
      if (!matches.length) { list.innerHTML = '<div class="combo-empty">No perpetual matches "' + esc(q) + '"</div>'; return; }
      list.innerHTML = matches.map(function (p) {
        var starred = S.watchlist.indexOf(p.symbol) !== -1;
        return '<div class="combo-item" data-sym="' + esc(p.symbol) + '">' +
          '<span class="sym">' + esc(p.symbol) + (starred ? ' <span class="star">★</span>' : '') + '</span>' +
          '<span class="meta"><span>' + esc(p.base) + '</span><span>' + p.pricePrecision + 'dp</span></span></div>';
      }).join('');
    };

    input.addEventListener('focus', function () { render(input.value === S.symbol ? '' : input.value); list.classList.add('open'); });
    input.addEventListener('input', function () { render(input.value); list.classList.add('open'); });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        var first = list.querySelector('.combo-item');
        if (first) { selectSymbol(first.getAttribute('data-sym')); }
        else if (input.value.trim()) { selectSymbol(input.value.trim().toUpperCase()); }
        list.classList.remove('open'); input.blur();
      } else if (ev.key === 'Escape') { list.classList.remove('open'); input.blur(); }
    });
    list.addEventListener('click', function (ev) {
      var item = ev.target.closest('.combo-item');
      if (!item) return;
      selectSymbol(item.getAttribute('data-sym'));
      list.classList.remove('open'); input.blur();
    });
    document.addEventListener('click', function (ev) {
      if (!el.contains(ev.target)) list.classList.remove('open');
    });

    $('profSeg').addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-p]');
      if (!b) return;
      S.profile = b.getAttribute('data-p');
      LS.set('profile', S.profile);
      renderPicker(); reanalyze(); renderAll();
    });
    $('reloadBtn').addEventListener('click', function () { load(S.symbol); });
  }

  function renderProfileToggle() { renderPicker(); }

  function selectSymbol(sym) {
    if (!sym || sym === S.symbol) { load(sym || S.symbol); return; }
    var known = S.pairs.some(function (p) { return p.symbol === sym; });
    if (!known) { S.error = 'Unknown pair "' + sym + '" — not listed on PCS Perps.'; renderAll(); return; }
    S.symbol = sym; LS.set('symbol', sym);
    closeStream();
    renderPicker();
    load(sym);
  }

  /* -------------------------------------------------------------- stream */

  var streamHandle = null;
  function startStream() {
    closeStream();
    if (typeof WebSocket === 'undefined') return;
    try {
      streamHandle = D.stream(S.symbol, '1m', {
        onOpen: function () { renderStatus(); },
        onKline: function (k) {
          if (!S.ctx || !k.closed) return;
          var arr = S.ctx.bars['1h'];
          if (!arr || !arr.length) return;
          /* Roll the just-closed 1m candle into the live 1h bar, or append a
           * new one when the hour turns over. Enough to keep price and the
           * sparkline honest without re-running the whole model every minute. */
          var hourStart = Math.floor(k.t / 3600000) * 3600000;
          var lastBar = arr[arr.length - 1];
          if (lastBar.t === hourStart) {
            lastBar.c = k.c; lastBar.h = Math.max(lastBar.h, k.h); lastBar.l = Math.min(lastBar.l, k.l);
            lastBar.v += k.v; lastBar.q += k.q; lastBar.tbb += k.tbb; lastBar.ct = k.ct;
          } else if (hourStart > lastBar.t) {
            arr.push({ t: hourStart, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v, ct: k.ct, q: k.q, n: 1, tbb: k.tbb, tba: k.tba });
            if (arr.length > 1200) arr.shift();
          }
          renderStatus();
          renderChart();
        },
        onMark: function (m) {
          if (S.ctx && S.ctx.deriv) {
            S.ctx.deriv.markPrice = m.markPrice;
            S.ctx.deriv.lastFundingRate = m.fundingRate;
          }
        }
      });
    } catch (e) { /* stream is an enhancement; polling still works */ }
  }
  function closeStream() { if (streamHandle) { try { streamHandle.close(); } catch (e) {} streamHandle = null; } }

  /* ----------------------------------------------------------------- boot */

  function boot() {
    renderStatus('Loading pair universe…', '');
    D.pairs().then(function (list) {
      S.pairs = list;
      renderPicker();
      var known = list.some(function (p) { return p.symbol === S.symbol; });
      if (!known) S.symbol = 'BTCUSDT';
      return load(S.symbol);
    }).catch(function (e) {
      S.error = 'Could not load the pair list from fapi.asterdex.com — ' + (e && e.message ? e.message : e);
      renderStatus('Pair list failed', 'err');
      renderAll();
    });
    window.addEventListener('resize', function () {
      clearTimeout(boot._rt);
      boot._rt = setTimeout(function () { renderChart(); if (S.backtest && S.backtest.ok) renderBacktest(); }, 180);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
