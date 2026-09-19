/* PCS-Perp-Predict — market data client.
 *
 * Talks to the same endpoints the PancakeSwap Perps frontend uses:
 *   fapi.asterdex.com  (market data, keyless, CORS: *)
 *   fstream.asterdex.com (websocket streams)
 *
 * Runs unchanged in the browser and in Node (global fetch), so the live app and
 * the test harness exercise identical code.
 */
(function (root, factory) {
  var api = factory(
    (typeof module === 'object' && module.exports) ? require('./indicators.js')
      : (typeof globalThis !== 'undefined' ? globalThis.PPIndicators : null)
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PPData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (I) {
  'use strict';

  var FAPI = 'https://fapi.asterdex.com';
  var WSS = 'wss://fstream.asterdex.com/ws';

  var cache = {};
  function cached(key, ttlMs, producer) {
    var now = Date.now(), hit = cache[key];
    if (hit && now - hit.t < ttlMs) return Promise.resolve(hit.v);
    return producer().then(function (v) { cache[key] = { t: Date.now(), v: v }; return v; });
  }

  function fetchJSON(url, timeoutMs) {
    timeoutMs = timeoutMs || 20000;
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs) : null;
    return fetch(url, ctl ? { signal: ctl.signal } : undefined).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
      return res.json();
    }).catch(function (e) {
      if (timer) clearTimeout(timer);
      throw e;
    });
  }

  function q(params) {
    return Object.keys(params).filter(function (k) { return params[k] !== undefined && params[k] !== null; })
      .map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
  }

  /* ---- exchange info: the pair universe PCS Perps lists ---- */

  function exchangeInfo() {
    return cached('exchangeInfo', 10 * 60 * 1000, function () {
      return fetchJSON(FAPI + '/fapi/v1/exchangeInfo');
    });
  }

  /* Perpetual contracts that are actually trading. This is the list the
   * selector is built from, so it stays in sync without a hardcoded whitelist. */
  function pairs() {
    return exchangeInfo().then(function (info) {
      return info.symbols.filter(function (s) {
        return s.status === 'TRADING' && s.contractType === 'PERPETUAL';
      }).map(function (s) {
        var tick = null, step = null, minQty = null;
        (s.filters || []).forEach(function (f) {
          if (f.filterType === 'PRICE_FILTER') tick = parseFloat(f.tickSize);
          if (f.filterType === 'LOT_SIZE') { step = parseFloat(f.stepSize); minQty = parseFloat(f.minQty); }
        });
        return {
          symbol: s.symbol,
          base: s.baseAsset,
          quote: s.quoteAsset,
          pricePrecision: s.pricePrecision,
          quantityPrecision: s.quantityPrecision,
          tickSize: tick, stepSize: step, minQty: minQty,
          maxLeverage: 200
        };
      });
    });
  }

  function sortForDropdown(list) {
    /* Majors first, then by symbol — a bare alphabetical list of 581 pairs is
     * unusable in a dropdown. */
    var majors = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'CAKE', 'ADA', 'AVAX', 'LINK', 'SUI', 'HYPE'];
    return list.slice().sort(function (a, b) {
      var ai = majors.indexOf(a.base), bi = majors.indexOf(b.base);
      if (ai !== -1 || bi !== -1) {
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      }
      return a.symbol.localeCompare(b.symbol);
    });
  }

  /* ---- market data ---- */

  function klines(symbol, interval, limit) {
    return fetchJSON(FAPI + '/fapi/v1/klines?' + q({ symbol: symbol, interval: interval, limit: limit || 500 }))
      .then(I.parseKlines);
  }

  function premiumIndex(symbol) {
    return fetchJSON(FAPI + '/fapi/v1/premiumIndex?' + q({ symbol: symbol }));
  }

  function fundingRate(symbol, limit) {
    return fetchJSON(FAPI + '/fapi/v1/fundingRate?' + q({ symbol: symbol, limit: limit || 100 }));
  }

  function openInterest(symbol) {
    return fetchJSON(FAPI + '/fapi/v1/openInterest?' + q({ symbol: symbol }));
  }

  function ticker24h(symbol) {
    return fetchJSON(FAPI + '/fapi/v1/ticker/24hr?' + q({ symbol: symbol }));
  }

  function depth(symbol, limit) {
    return fetchJSON(FAPI + '/fapi/v1/depth?' + q({ symbol: symbol, limit: limit || 500 }));
  }

  /* Open-interest history lives under the Binance-style /futures/data prefix.
   * Aster does not implement it; we probe once and remember, because the factor
   * that needs it degrades gracefully instead of failing the whole analysis. */
  function openInterestHist(symbol, period, limit) {
    var key = 'oiHistUnsupported';
    if (cache[key] && Date.now() - cache[key].t < 3600 * 1000) return Promise.resolve(null);
    return fetchJSON(FAPI + '/futures/data/openInterestHist?' + q({ symbol: symbol, period: period || '1h', limit: limit || 48 }), 8000)
      .then(function (v) { return Array.isArray(v) && v.length ? v : null; })
      .catch(function () { cache[key] = { t: Date.now(), v: null }; return null; });
  }

  /* ---- aggregate ---- */

  var DEFAULT_INTERVALS = ['15m', '1h', '4h', '1d'];

  /* One round trip per source, all in parallel. A failure in an optional source
   * (order book, open interest) must not sink the analysis. */
  function loadContext(symbol, opts) {
    opts = opts || {};
    var intervals = opts.intervals || DEFAULT_INTERVALS;
    var limits = { '15m': 400, '1h': 1000, '4h': 750, '1d': 500 };
    var soft = function (p, fallback) { return p.catch(function () { return fallback; }); };

    var jobs = intervals.map(function (tf) { return klines(symbol, tf, limits[tf] || 500); });

    return Promise.all(jobs).then(function (series) {
      var bars = {};
      intervals.forEach(function (tf, idx) { bars[tf] = series[idx]; });

      return Promise.all([
        soft(ticker24h(symbol), {}),
        soft(premiumIndex(symbol), {}),
        soft(fundingRate(symbol, 100), []),
        soft(openInterest(symbol), {}),
        soft(depth(symbol, 500), null),
        openInterestHist(symbol, '1h', 48)
      ]).then(function (r) {
        var deriv = {
          ticker: r[0] || {},
          markPrice: r[1] && r[1].markPrice ? parseFloat(r[1].markPrice) : null,
          indexPrice: r[1] && r[1].indexPrice ? parseFloat(r[1].indexPrice) : null,
          lastFundingRate: r[1] && r[1].lastFundingRate !== undefined ? parseFloat(r[1].lastFundingRate) : null,
          nextFundingTime: r[1] ? r[1].nextFundingTime : null,
          openInterest: r[3] && r[3].openInterest ? parseFloat(r[3].openInterest) : null,
          depth: r[4] || null
        };
        return {
          symbol: symbol, bars: bars, deriv: deriv,
          fundingHist: r[2] || [], oiHist: r[5] || null,
          loadedAt: Date.now()
        };
      });
    });
  }

  /* ---- live stream ----
   * Multiplexed futures stream: combined kline + markPrice. Returns a handle
   * with .close(); auto-reconnects with backoff because these sockets drop. */
  function stream(symbol, interval, handlers) {
    handlers = handlers || {};
    var closed = false, backoff = 1000, sock = null;
    var sym = symbol.toLowerCase();

    function connect() {
      if (closed) return;
      try {
        sock = new WebSocket(WSS + '/' + sym + '@kline_' + interval + '/' + sym + '@markPrice');
      } catch (e) {
        setTimeout(connect, backoff);
        return;
      }
      sock.onopen = function () { backoff = 1000; if (handlers.onOpen) handlers.onOpen(); };
      sock.onmessage = function (ev) {
        var m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.e === 'kline' && handlers.onKline) {
          handlers.onKline({
            t: m.k.t, o: +m.k.o, h: +m.k.h, l: +m.k.l, c: +m.k.c, v: +m.k.v,
            ct: m.k.T, q: +m.k.q, tbb: +m.k.V, tba: +m.k.Q, closed: m.k.x
          });
        } else if (m.e === 'markPriceUpdate' && handlers.onMark) {
          handlers.onMark({ markPrice: +m.p, indexPrice: +m.i, fundingRate: +m.r, nextFundingTime: m.T });
        }
      };
      sock.onclose = function () {
        if (handlers.onClose) handlers.onClose();
        if (closed) return;
        backoff = Math.min(backoff * 2, 30000);
        setTimeout(connect, backoff);
      };
      sock.onerror = function () { try { sock.close(); } catch (e) {} };
    }
    connect();
    return {
      close: function () { closed = true; try { sock && sock.close(); } catch (e) {} }
    };
  }

  function clearCache() { cache = {}; }

  return {
    FAPI: FAPI, WSS: WSS, DEFAULT_INTERVALS: DEFAULT_INTERVALS,
    fetchJSON: fetchJSON, exchangeInfo: exchangeInfo, pairs: pairs,
    sortForDropdown: sortForDropdown, klines: klines, premiumIndex: premiumIndex,
    fundingRate: fundingRate, openInterest: openInterest, ticker24h: ticker24h,
    depth: depth, openInterestHist: openInterestHist, loadContext: loadContext,
    stream: stream, clearCache: clearCache
  };
});
