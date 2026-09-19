# PCS-Perp-Predict

Multi-faceted technical + derivatives analysis for **every perpetual listed on
[PancakeSwap Perps](https://pancakeswap.finance/perps)** — a LONG / SHORT / NO
TRADE verdict with an ATR-and-structure stop, a scaled target ladder, position
sizing tied to a defined risk budget, and a walk-forward backtest of the exact
same engine.

**It also publishes its own measured performance, including where it loses.**
That is the point of the project. See [Validation](#validation--read-this-first).

Live: <https://nwfella.github.io/pcs-perp-predict/> · single file, zero dependencies.

---

## Validation — read this first

The engine was built, then measured. The measurement does not support treating
its signals as an edge, and the app says so on every verdict.

**Information coefficient** (correlation between a factor's score at bar *t* and
the forward return, 3,768 samples over 12 symbols):

| Window | Composite IC (24h) | t |
|---|---|---|
| 1h bars (~62 days) | **−0.123** | −1.59 |
| 4h bars (~250 days) | +0.039 (6h) | 0.57 |

**Out-of-sample walk-forward**, fit symbols vs 6 held-out symbols, costs charged
(0.035% taker per leg + 0.02% slippage per leg), balanced risk gates:

| Set | Weight profile | Trades | Win rate | Avg R | Profit factor | Max DD | t |
|---|---|---|---|---|---|---|---|
| fit | balanced (unfitted prior) | 808 | 40.0% | −0.086 | 0.87 | 71.0% | −1.72 |
| fit | IC-calibrated (both-window rule) | 456 | 40.4% | −0.052 | 0.92 | 43.0% | −0.77 |
| fit | IC-calibrated (strong-t rule) | 408 | 40.9% | +0.020 | 1.03 | 44.4% | 0.27 |
| **held out** | balanced (unfitted prior) | 315 | 51.7% | **+0.168** | 1.32 | 26.8% | **2.17** |
| **held out** | IC-calibrated (both-window rule) | 154 | 37.0% | −0.040 | 0.94 | 35.3% | −0.34 |
| **held out** | IC-calibrated (strong-t rule) | 161 | 46.6% | +0.122 | 1.22 | 21.7% | 1.11 |

**Do not read the held-out t of 2.17 as an edge.** The same unfitted profile, with
no change in weighting, is *negative* on the fit symbols and *positive* on the
held-out ones. A profile that flips sign across halves is measuring noise. On top
of that, the risk gates were recalibrated after a diagnosis that ran on the fit
symbols, so this held-out column is a clean test of the **weights** but not of the
**gates**. The app states both caveats in its own validation panel.

The conclusions that survive:

1. **No profile has an edge that clears costs.** The best held-out figure is
   statistically indistinguishable from a coin flip once the sign flip is
   accounted for.
2. **Both data-fitted weightings were worse in-sample than the unfitted prior**,
   and the reweighting that looked strongest in-sample (IC, 4h window) was the
   worst held out. That is overfitting, observed rather than assumed.
3. **Exit policy matters more than the entry signal.** On identical signals,
   taking the first target all-out scored −0.057R per trade while a 3R single
   target scored +0.027R, and the default 1.5R/3R/5R ladder with a 25% runner
   scored −0.008R. Letting winners run beats banking the first target.

## What changed after the first release

The first version said NO TRADE on essentially every pair, and the diagnosis
(now a script — `scripts/diagnose_gates.mjs`) showed why with numbers:

| Gate | Was | Problem |
|---|---|---|
| No-trade band | ±22 | Sat at the composite's own **90th percentile**, manufacturing a 90% rejection rate by construction |
| Room check | ≥ 2.0R | The median attainable room on 1h is **0.88R** — a structurally unsatisfiable demand, rejecting 72% of pairs on its own. It was also conceptually wrong: it demanded clear air to the nearest swing, but this is a trend-following model and trend entries *expect* to break structure |
| Stop | 1.5 × ATR | Often wider than the room available, so every target sat beyond a level price could not reach |

Fixes: the room check became a "not pinned against structure" test (≥ 0.5R), the
band moved to ±15, and the stop is now capped by the available room so the reward
ladder stays reachable (`room / 1.5`, floored at 0.6 ATR). Gate pass rate went
from **6.7%** of bars to **23.4%**.

Three tiers now exist so the tool always says something useful:

| Verdict | Meaning |
|---|---|
| `LONG` / `SHORT` | Every gate passed. A plan with entry, stop, targets and sizing is published |
| `SETUP LONG` / `SETUP SHORT` | A directional read exists but gates blocked it. Direction, composite and evidence are shown; **levels are withheld** when the geometry is incoherent (price pinned against structure), because publishing targets the market cannot reach is fiction |
| `NO TRADE` | The composite is inside the lean band — there is genuinely no direction |

A **risk-gate selector** (conservative / balanced / aggressive) and a
**directional lean** are always visible, so selectivity is your choice rather than
a hidden default. Every panel is collapsible, including the six factor groups, and
the layout is remembered in `localStorage`.


---

## What it does

* Picks any of **581 perpetual contracts** PCS Perps lists — read live from the
  exchange, so the selector never goes stale.
* Runs **22 weighted factors in 6 groups**, each emitting a score in
  `[−1, +1]` plus the actual numbers behind it. No black box: every point of the
  composite traces to a named reading you can check on a chart.
* Emits **LONG / SHORT / NO TRADE** with a composite score, a confidence figure,
  and the specific reason for every rejection.
* Produces a **trade plan**: ATR-and-structure stop, scaled targets, attainment
  check against the next opposing structure.
* Sizes the position from **equity × risk%**, and refuses leverage whose
  liquidation price would land inside the stop.
* **Backtests the identical code path** bar by bar, with costs, on the symbol in
  front of you.

### The 6 groups

| Group | Weight | Factors |
|---|---|---|
| A Trend | 0.26 | EMA stack 1h + 4h, ADX/DMI, market structure (BOS/CHoCH from confirmed swings), channel position |
| B Momentum | 0.20 | RSI level+slope, RSI divergence, MACD histogram, momentum/ATR |
| C Volatility & regime | 0.12 | Volatility-confirmed channel breakout, mean-reversion stretch, return autocorrelation |
| D Volume & flow | 0.16 | Relative volume, **cumulative taker delta**, OBV trend, VWAP side |
| E Derivatives context | 0.16 | Funding rate level+percentile, open interest vs price quadrant, 15m taker aggression |
| F Levels & liquidity | 0.10 | Room to structure, liquidity-sweep detection, order-book imbalance |

Cumulative taker delta uses the exchange's own `takerBuyBaseVolume` field rather
than inferring flow from candle direction — real aggressor data, not a guess.

### Trade gating

A trade is emitted only when **all** hold: `|composite| ≥ 22`, weighted agreement
`≥ 58%`, 24h volume `≥ $1M`, realised volatility inside `0.05–15%` per bar, model
coverage `≥ 80%`, and `≥ 2R` of room before the next opposing structure. Otherwise
the verdict is NO TRADE **with the reason stated** — it never invents a level for a
signal that failed its own filters.

---

## Data source

PCS Perps was rebuilt on **Aster's orderbook infrastructure**. The PancakeSwap
frontend bundle hardcodes its own endpoints, which were read directly out of
`_app-*.js`:

| Purpose | Endpoint |
|---|---|
| Market data | `https://fapi.asterdex.com` |
| Streams | `wss://fstream.asterdex.com/ws` |
| Order placement (auth) | `https://perps-api.pancakeswap.com/api/perps/order` |

`fapi.asterdex.com` needs **no API key** and returns `Access-Control-Allow-Origin: *`
on both preflight and GET, so the browser calls it directly with no proxy.

Verified keyless endpoints: `exchangeInfo`, `klines`, `markPriceKlines`,
`indexPriceKlines`, `continuousKlines`, `premiumIndex`, `fundingRate`,
`openInterest`, `ticker/24hr`, `depth`, `aggTrades`, `time`.

**Not available:** the Binance-style `/futures/data/*` group (long/short account
ratios, open-interest history) 404s on Aster. Crowd positioning is therefore read
from **funding rate** and the **OI/price quadrant**; where a factor has no series
to read, its weight is redistributed and the UI says which factor went inactive
rather than quietly scoring it zero.

This project only **reads** public market data. It places no orders and holds no
keys.

---

## Layout

```
index.html                  built artifact — open it directly, no server needed
src/indicators.js           EMA/SMA/RSI/MACD/ATR/ADX/Bollinger/OBV/VWAP/swings/IC helpers
src/engine.js               the 22 factors, weight profiles, gating, plan, sizing
src/data.js                 Aster fapi client + WebSocket multiplexer
src/backtest.js             walk-forward replay, fill simulation, cost model, stats
src/chart.js                canvas candlesticks + equity curve
src/app.js                  UI shell: state, rendering, watchlist, alerts
src/styles.css              dark theme
src/index.template.html     HTML shell with injection markers
scripts/build.mjs           src/ -> single-file index.html
scripts/calibrate.mjs       gated strategy + exit-policy comparison -> data/calibration.json
scripts/diagnose_gates.mjs  why setups are rejected, per gate, with counterfactuals
scripts/ic_study.mjs        information coefficient per factor -> data/ic_study.json
scripts/oos_test.mjs        held-out symbol test -> data/oos_test.json
scripts/record_fixtures.mjs capture trimmed live API responses for the test gate
scripts/verify_site.js      jsdom gate: 153 assertions over the built page
scripts/verify_live.js      post-deploy gate: boots the DEPLOYED url against the live API
data/                       baked validation results (inlined into index.html at build)
tests/fixtures.json         recorded API responses used by the gate
```

## Running it

```bash
node scripts/build.mjs          # src/ -> index.html  (open index.html directly)
node scripts/verify_site.js     # 153-assertion gate over the built page (needs jsdom)
node scripts/verify_live.js     # boots the deployed URL against the live exchange
node scripts/diagnose_gates.mjs # per-gate rejection rates + counterfactuals
node scripts/calibrate.mjs      # exit-policy + gated-strategy measurement
node scripts/ic_study.mjs       # factor information coefficients   (BASE=4h for the long window)
node scripts/oos_test.mjs       # held-out symbol validation
```

`calibrate.mjs` and `oos_test.mjs` accept `STRICT=conservative|balanced|aggressive`
so the effect of the risk gates is measurable rather than guessed.

There is no build step to *run* the page — `index.html` is self-contained and
opens over `file://`.

## Deployment

GitHub Pages serves `master` at the repository root:

<https://nwfella.github.io/pcs-perp-predict/>

`scripts/verify_live.js` closes the loop after every deploy. It fetches the
deployed page, checks the served bytes are **sha256-identical to the local build**
(so what is on Pages is exactly what passed the local gate), then boots it in
jsdom with real network access and asserts a live connection, the live pair
universe, a rendered verdict, evidence rows, heatmap, plan, and canvas output.
Last run: 20/20 assertions, served sha `6600cd607f0f` matching local, 581
perpetuals fetched, 23 factor rows, 260 candles drawn, no script errors.

If it reports a blank page with no script errors, check for a security-proxy
interstitial: the gate explicitly flags a response body that has been replaced by
an `iframe-container` / `threatprotection` redirect, which is a network appliance
rewriting the page rather than a fault in the app.

### CORS

The browser calls the exchange directly, so the preflight has to pass. Verified
from the Pages origin:

```
$ curl -i -X OPTIONS 'https://fapi.asterdex.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=1' \
    -H 'Origin: https://nwfella.github.io' -H 'Access-Control-Request-Method: GET'
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS

$ curl -i 'https://fapi.asterdex.com/fapi/v1/ticker/24hr?symbol=BTCUSDT' \
    -H 'Origin: https://nwfella.github.io'
HTTP/1.1 200 OK
Access-Control-Allow-Origin: *
```

No proxy, no worker, no key.

## Method notes and limitations

* Signals use only bars that had **closed** at the evaluated moment; higher
  timeframes are truncated by close time, so a forming 4h candle cannot leak in.
* If a bar's range contains both the stop and a target, the **stop is assumed to
  fill first**. Real fills usually land between the two, so this is pessimistic.
* Backtests charge entry and exit fees plus slippage. They do **not** charge
  funding cost of holding, and they do not simulate liquidation — a stop-out is
  assumed to fill at the stop.
* Open-interest history, 15m taker aggression and order-book imbalance have no
  historical series on this venue, so the backtest runs without them and their
  weight is redistributed. The live analysis does use them.
* Every result above comes from **one market regime** (the most recent ~16 days
  of 1h bars and ~250 days of 4h bars). A single regime cannot distinguish an edge
  from a coincidence, which is exactly what the held-out table shows.
* `data/*.json` are snapshots. Re-run the scripts to refresh them.

## Not financial advice

This tool performs a transparent, rule-based summary of public market data. It
does not predict prices and has not demonstrated a statistically significant edge.
Perpetual futures with leverage can lose your entire margin and more. Verify every
level yourself before risking capital.

## Donations

Any chain, any token:

`0xe09e6c33b444d246F1005BdCd404ff33Cb709EcA`

## License

MIT — see [LICENSE](LICENSE). Additional notes on market data, the absence of any
financial advice, and the absence of any accuracy warranty are in
[NOTICE.md](NOTICE.md).

Market data © Aster / PancakeSwap. This project is unaffiliated with both.
