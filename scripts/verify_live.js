#!/usr/bin/env node
/* PCS-Perp-Predict — post-deploy live verification.
 *
 * Fetches the DEPLOYED page and boots it in jsdom with real network access, so
 * the deployed artifact is proven to work end to end: pair list from the live
 * exchange, analysis rendered, plan/sizing present, no error state.
 *
 * Why this exists separately from verify_site.js: that gate runs the local build
 * against recorded fixtures. This one runs the live URL against the live API, so
 * a bad deploy, a stale page, or an endpoint that broke in production is caught.
 *
 * Note on CORS: Node's fetch does not enforce browser CORS, so this proves the
 * data layer and render path, not the browser preflight. CORS is verified
 * separately by inspecting the Access-Control-Allow-Origin header on a real
 * preflight — see README.
 *
 * Usage: node scripts/verify_live.js [url]
 * Exit code 0 = pass.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JSDOM, VirtualConsole } = require('jsdom');

const URL_ARG = process.argv[2] || 'https://nwfella.github.io/pcs-perp-predict/';
const LOCAL = path.resolve(__dirname, '..', 'index.html');

const fails = [];
const info = [];
const ok = (c, m) => (c ? info.push('  ok   ' + m) : fails.push('  FAIL ' + m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const draw = { rects: 0, lines: 0, texts: [] };
function stubCtx() {
  const noop = () => {};
  return new Proxy({
    fillRect: () => draw.rects++,
    fillText: (t) => draw.texts.push(String(t)),
    createLinearGradient: () => ({ addColorStop() {} }),
    measureText: () => ({ width: 10 }),
    getImageData: () => ({ data: new Uint8ClampedArray(8) }),
    moveTo: () => draw.lines++, lineTo: () => draw.lines++,
    beginPath: noop, closePath: noop, stroke: noop, fill: noop, arc: noop,
    setTransform: noop, setLineDash: noop, save: noop, restore: noop, clearRect: noop,
  }, { get: (t, p) => (p in t ? t[p] : (typeof p === 'string' && p.startsWith('set') ? noop : undefined)) });
}

(async () => {
  console.log('verifying live deployment: ' + URL_ARG + '\n');

  const res = await fetch(URL_ARG, { redirect: 'follow' });
  ok(res.status === 200, 'live URL returns HTTP 200 (got ' + res.status + ')');
  const html = await res.text();
  ok(html.length > 100000, 'served page is a real build (' + (html.length / 1024).toFixed(0) + ' KB)');

  /* Byte-identity with the local build is the strongest deploy check: it proves
   * what is on Pages is exactly what passed the local gate. Line endings are
   * normalised first, because git may rewrite LF on checkout without changing
   * the actual content. */
  if (fs.existsSync(LOCAL)) {
    const norm = (s) => s.replace(/\r\n/g, '\n');
    const hl = crypto.createHash('sha256').update(norm(fs.readFileSync(LOCAL, 'utf8'))).digest('hex');
    const hb = crypto.createHash('sha256').update(norm(html)).digest('hex');
    ok(hl === hb, 'served bytes match the local build (sha256 ' + hl.slice(0, 16) + ' / ' + hb.slice(0, 16) + ')');
  } else {
    info.push('  note local index.html not found — skipped the identity check');
  }

  /* A security proxy that rewrites the page must be reported as such rather than
   * surfacing as mysterious blank rendering. */
  ok(!/threatprotection|iframe-container|Access Denied|Web Filter/i.test(html.slice(0, 3000)),
    'served page is our app, not a security-proxy interstitial');

  /* ---- boot it with real network ---- */
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', (e) => errs.push('jsdomError: ' + (e.message || e)));
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: URL_ARG });
  const win = dom.window;
  win.HTMLCanvasElement.prototype.getContext = () => stubCtx();
  Object.defineProperty(win.HTMLCanvasElement.prototype, 'clientWidth', { get: () => 720, configurable: true });
  win.WebSocket = class { constructor() {} close() {} };

  /* jsdom has no fetch and its AbortController produces a signal Node's fetch
   * will not accept, so both are bridged from the Node realm. This is the whole
   * point of the gate: the live page must reach the real exchange. */
  win.fetch = (u, o) => globalThis.fetch(u, o);
  win.AbortController = globalThis.AbortController;
  win.Headers = globalThis.Headers;
  win.Request = globalThis.Request;
  win.Response = globalThis.Response;

  for (let i = 0; i < 80; i++) {
    await sleep(75);
    const t = win.document.getElementById('statusText');
    if (t && /Live|Error|Failed/.test(t.textContent)) break;
  }
  await sleep(600);

  const doc = win.document;
  const txt = (id) => { const e = doc.getElementById(id); return e ? e.textContent : ''; };
  const htmlOf = (id) => { const e = doc.getElementById(id); return e ? e.innerHTML : ''; };

  ok(/Live/.test(txt('statusText')), 'live page reports a live data connection ("' + txt('statusText') + '")');
  const picker = htmlOf('picker');
  const n = Number((picker.match(/(\d+)\s+perpetuals/) || [])[1] || 0);
  ok(n > 500, 'pair universe fetched live from the exchange (' + n + ' perpetuals)');

  const v = htmlOf('verdictCard');
  ok(/LONG|SHORT|NO TRADE/.test(v), 'verdict rendered from live data');
  ok(/gauge-needle/.test(v), 'composite gauge rendered');
  ok(/What the .* profile actually measured/.test(v), 'measured expectancy shown next to the verdict');

  const f = htmlOf('factorCard');
  ok((f.match(/class="fid"/g) || []).length >= 20, 'factor evidence rendered (' + (f.match(/class="fid"/g) || []).length + ' rows)');
  ok((htmlOf('heatCard').match(/heat-cell/g) || []).length >= 16, 'multi-timeframe heatmap rendered');
  ok(/Mark price/.test(htmlOf('derivCard')), 'derivatives panel rendered');
  ok(/Model validation/.test(htmlOf('validCard')), 'validation panel rendered with baked results');
  ok(/Walk-forward backtest/.test(htmlOf('btCard')), 'backtest panel rendered');
  ok(draw.rects > 20, 'candles drawn on canvas (' + draw.rects + ' fills)');

  const all = doc.body.textContent || '';
  ok(/0xe09e6c33b444d246F1005BdCd404ff33Cb709EcA/.test(all), 'donation address present');
  ok(/Not financial advice/.test(all), 'disclaimer present');
  ok(/MIT licensed/.test(all), 'licence shown');
  ok(txt('engineVer') !== '—', 'engine version displayed (' + txt('engineVer') + ')');

  const real = errs.filter((e) => !/Not implemented|Could not parse CSS|WebSocket/.test(e));
  ok(real.length === 0, 'no script errors on the live page' + (real.length ? ' -> ' + real.slice(0, 2).join(' | ') : ''));

  console.log(info.join('\n'));
  if (fails.length) { console.log('\n' + fails.join('\n') + '\n\n' + fails.length + ' FAILED, ' + info.length + ' passed\n'); process.exit(1); }
  console.log('\nall ' + info.length + ' live assertions passed\n');
  dom.window.close();
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
