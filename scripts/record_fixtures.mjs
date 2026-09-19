#!/usr/bin/env node
/* Record trimmed live Aster API responses into tests/fixtures.json so the
 * jsdom verification gate runs deterministically and offline.
 *
 * Trimmed deliberately: the real exchangeInfo is ~830 KB, which would dominate
 * the repo for no benefit. The fixture keeps a representative slice of symbols
 * including the majors plus a few exotic ones.
 *
 * Usage: node scripts/record_fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const FAPI = 'https://fapi.asterdex.com';

const SYMBOL = process.env.SYM || 'BTCUSDT';
const KEEP = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'CAKEUSDT', '1000PEPEUSDT'];

const get = async (p) => {
  const res = await fetch(FAPI + p, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + p);
  return res.json();
};

(async () => {
  console.log('recording fixtures for ' + SYMBOL + ' …');
  const info = await get('/fapi/v1/exchangeInfo');
  const symbols = info.symbols.filter((s) => s.status === 'TRADING' && s.contractType === 'PERPETUAL');
  const kept = symbols.filter((s) => KEEP.includes(s.symbol));

  const fixtures = {
    recordedAt: new Date().toISOString(),
    source: FAPI,
    symbol: SYMBOL,
    trimmed: { totalSymbols: symbols.length, keptSymbols: kept.map((s) => s.symbol) },
    exchangeInfo: { timezone: info.timezone, futuresType: info.futuresType, symbols: kept },
    responses: {}
  };

  const paths = [
    `/fapi/v1/klines?symbol=${SYMBOL}&interval=15m&limit=400`,
    `/fapi/v1/klines?symbol=${SYMBOL}&interval=1h&limit=1000`,
    `/fapi/v1/klines?symbol=${SYMBOL}&interval=4h&limit=750`,
    `/fapi/v1/klines?symbol=${SYMBOL}&interval=1d&limit=500`,
    `/fapi/v1/klines?symbol=${SYMBOL}&interval=1m&limit=100`,
    `/fapi/v1/ticker/24hr?symbol=${SYMBOL}`,
    `/fapi/v1/premiumIndex?symbol=${SYMBOL}`,
    `/fapi/v1/fundingRate?symbol=${SYMBOL}&limit=100`,
    `/fapi/v1/openInterest?symbol=${SYMBOL}`,
    `/fapi/v1/depth?symbol=${SYMBOL}&limit=500`
  ];

  for (const p of paths) {
    process.stdout.write('  ' + p + ' … ');
    try {
      fixtures.responses[p] = await get(p);
      console.log('ok');
    } catch (e) {
      console.log('FAIL ' + e.message);
      fixtures.responses[p] = null;
    }
  }

  const dest = path.join(root, 'tests/fixtures.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(fixtures));
  const kb = (Buffer.byteLength(JSON.stringify(fixtures)) / 1024).toFixed(1);
  console.log('\nwrote tests/fixtures.json (' + kb + ' KB), ' + kept.length + ' symbols of ' + symbols.length + ' total');
})().catch((e) => { console.error(e); process.exit(1); });
