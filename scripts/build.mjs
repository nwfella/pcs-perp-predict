#!/usr/bin/env node
/* PCS-Perp-Predict — build.
 *
 * Concatenates src/ into a single self-contained index.html with zero runtime
 * dependencies: no CDN, no fetch for local assets, no build step for the user.
 *
 * Validation JSON (information coefficients, out-of-sample test, exit-policy
 * calibration) is baked in so the page states its own measured performance
 * without needing an extra request.
 *
 * Usage: node scripts/build.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src = path.join(root, 'src');

const read = (p) => fs.readFileSync(p, 'utf8');
const readJSON = (p) => { try { return JSON.parse(read(p)); } catch { return null; } };

const template = read(path.join(src, 'index.template.html'));
const styles = read(path.join(src, 'styles.css'));

const jsFiles = ['indicators.js', 'engine.js', 'data.js', 'backtest.js', 'chart.js', 'app.js'];
const js = {};
for (const f of jsFiles) js[f] = read(path.join(src, f));

/* ---- baked validation payload ---- */
const ic = readJSON(path.join(root, 'data/ic_study.json'));
const oos = readJSON(path.join(root, 'data/oos_test.json'));
const calibration = readJSON(path.join(root, 'data/calibration.json'));

const validation = {
  generatedAt: new Date().toISOString(),
  ic: ic ? {
    generatedAt: ic.generatedAt, samples: ic.samples, horizons: ic.horizons,
    symbols: ic.symbols, composite: ic.composite,
    factors: ic.factors.map((f) => ({ id: f.id, name: f.name, group: f.group, weight: f.weight, n: f.n, horizons: f.horizons }))
  } : null,
  oos: oos || null,
  calibration: calibration ? {
    generatedAt: calibration.generatedAt, baseLadder: calibration.baseLadder,
    ladders: calibration.ladders, blockerPct: calibration.blockerPct,
    gatedSignalPct: calibration.gatedSignalPct, distribution: calibration.distribution,
    limitations: calibration.limitations
  } : null
};

/* Guard the payload against breaking the page: JSON must not contain a literal
 * </script> that would close the tag early. */
const validationJS = 'window.PP_VALIDATION = ' +
  JSON.stringify(validation).replace(/<\/script/gi, '<\\/script') + ';';

/* ---- assemble ---- */
let out = template;
const inject = (marker, content) => {
  if (!out.includes(marker)) throw new Error('build: marker ' + marker + ' not found in template');
  out = out.replace(marker, () => content);
};

inject('/*__STYLES__*/', styles);
inject('/*__VALIDATION__*/', validationJS);
inject('/*__INDICATORS__*/', js['indicators.js']);
inject('/*__ENGINE__*/', js['engine.js']);
inject('/*__DATA__*/', js['data.js']);
inject('/*__BACKTEST__*/', js['backtest.js']);
inject('/*__CHART__*/', js['chart.js']);
inject('/*__APP__*/', js['app.js']);

/* Every module references the previous ones, so order matters — verify it. */
const order = ['PPIndicators', 'PPEngine', 'PPData', 'PPBacktest', 'PPChart'];
let lastAt = -1;
for (const name of order) {
  const at = out.indexOf('root.' + name + ' = api');
  if (at === -1) throw new Error('build: module ' + name + ' missing from output');
  if (at < lastAt) throw new Error('build: module ' + name + ' is out of order');
  lastAt = at;
}
if (out.indexOf('PP_VALIDATION') === -1) throw new Error('build: validation payload missing');

const dest = path.join(root, 'index.html');
fs.writeFileSync(dest, out);

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log('built index.html');
console.log('  size            ' + kb(Buffer.byteLength(out)));
console.log('  styles          ' + kb(Buffer.byteLength(styles)));
console.log('  scripts         ' + kb(Buffer.byteLength(Object.values(js).join(''))));
console.log('  validation      ' + (ic ? 'IC ✓ ' : 'IC ✗ ') + (oos ? 'OOS ✓ ' : 'OOS ✗ ') + (calibration ? 'calibration ✓' : 'calibration ✗'));
if (ic) console.log('  IC samples      ' + ic.samples.toLocaleString() + ' across ' + ic.symbols.length + ' symbols');
if (oos) {
  const t = oos.sets.test.profiles;
  console.log('  held-out avgR   balanced ' + t.balanced.avgR.toFixed(3) + '  |  ic ' + t.ic.avgR.toFixed(3));
}
console.log('\nopen it directly: file:///' + dest.replace(/\\/g, '/'));
