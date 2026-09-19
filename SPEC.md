# PCS-Perp-Predict — Specification

## What it is

A single-file, zero-dependency browser app that takes any perpetual futures pair
tradable on PancakeSwap Perps (PCS Perps), runs a **multi-faceted technical +
derivatives analysis**, and outputs a directional call — **LONG / SHORT / NO
TRADE** — with a confidence score, an ATR-and-structure-derived stop loss, a
scaled take-profit ladder, and position sizing tied to a defined risk budget.

It also **backtests the exact same decision code** over historical klines so the
signal quality is a measured number, not a claim.

## Data layer (verified live)

PCS Perps was rebuilt on Aster's orderbook infrastructure. The PancakeSwap
frontend bundle (`_app-*.js`) hardcodes:

| Purpose | Endpoint |
|---|---|
| Market data base | `https://fapi.asterdex.com` |
| WebSocket stream | `wss://fstream.asterdex.com/ws` |
| Order placement (auth) | `https://perps-api.pancakeswap.com/api/perps/order` |
| Income / trade sync (auth) | `.../api/perps/sync/{income,userTrades}` |

The pair universe is therefore Aster's `fapi/v1/exchangeInfo`, filtered to
`status === "TRADING"` and `contractType === "PERPETUAL"`. Reading it live keeps
the selector automatically in sync with what PCS lists — no hardcoded whitelist
to rot.

`fapi.asterdex.com` returns `Access-Control-Allow-Origin: *` on both preflight
and GET, so the browser fetches it directly with no proxy and no API key.

Verified keyless endpoints:

```
GET /fapi/v1/exchangeInfo                                        -> 581 perpetuals
GET /fapi/v1/klines?symbol=&interval=&limit=                     -> OHLCV + taker-buy volume
GET /fapi/v1/markPriceKlines | indexPriceKlines | continuousKlines
GET /fapi/v1/premiumIndex?symbol=                                -> mark, index, lastFundingRate, nextFundingTime
GET /fapi/v1/fundingRate?symbol=&limit=                          -> funding history
GET /fapi/v1/openInterest?symbol=                                -> open interest
GET /fapi/v1/ticker/24hr?symbol=                                 -> last, quoteVolume, high, low
GET /fapi/v1/depth?symbol=&limit=                                -> order book
GET /fapi/v1/aggTrades?symbol=&limit=                            -> taker prints
```

Not available on Aster (404): `/futures/data/*LongShort*Ratio`. Crowd
positioning is therefore proxied by **funding rate** and **OI/price quadrant**,
not by long/short account ratios.

History depth: `limit=1500` returns 1500 rows (1d -> back to 2022-08-12,
1h -> 62 days). Sufficient for real backtests.

## Engine: 22 weighted factors in 6 groups

Every factor emits a score in `[-1, +1]` (negative = short bias) plus machine
readable evidence. Group weights sum to 1.0; the composite is
`100 * Σ(score_i × weight_i)`.

| Group | Weight | Factors |
|---|---|---|
| A Trend | 0.26 | EMA stack 1h, EMA stack 4h, ADX/DMI, market structure (BOS/CHoCH), Donchian position |
| B Momentum | 0.20 | RSI level+slope, RSI divergence, MACD histogram, ROC/ATR |
| C Volatility / regime | 0.12 | Bollinger squeeze, ATR% regime, BB z-score (extension penalty) |
| D Volume / flow | 0.16 | Relative volume, OBV slope, cumulative delta (real taker-buy data), VWAP side |
| E Derivatives context | 0.16 | Funding rate level+percentile, OI vs price quadrant, mark-index basis |
| F Levels / liquidity | 0.10 | Room to run to next structure, liquidity-sweep detection, order book imbalance |

### Verdict gating

A trade is only emitted when **all** hold:

1. `|composite| >= 22`
2. weighted agreement `>= 0.58` (signals must not be cancelling out)
3. 24h quote volume `>= $1M` (liquidity floor)
4. realized volatility (ATR%) inside `[0.05%, 15%]` — not dead, not unhinged
5. reward:risk to the 3R target `>= 2.0`

Otherwise the verdict is **NO TRADE** and the reason is stated.

### Risk plan

* `stopDist = clamp(1.5 × ATR(1h), 0.35%, 6%)`, then widened to clear the nearest
  opposing swing level if one sits inside that band.
* Targets: `1.5R / 3R / 5R`, sized `40% / 35% / 25%`.
* After TP1 -> stop to breakeven. After TP2 -> ATR trailing stop.
* Liquidation guard: the selected leverage must put the liquidation price
  **beyond** the stop. Max safe leverage is computed and shown; if the requested
  leverage would liquidate first, the app flags it.
* Position sizing from `equity × risk% / stopDist` — notional, margin, and
  max loss in USD.

## Backtest

The same `analyze()` code path is replayed bar-by-bar over historical klines
using only data available at each bar (higher timeframes truncated to the bar's
close time — no look-ahead). Forward simulation is conservative: if stop and
target are both inside one bar's range, the **stop** is assumed to fill first.

Costs are modelled: configurable taker fee (both legs) plus slippage, converted
into R using the stop distance. Reported: trades, win rate, avg R, expectancy,
profit factor, max R-drawdown, longest losing streak, avg bars held, plus
buy-and-hold return over the same window for comparison.

## UI

Dark theme. Verdict card with a composite gauge and confidence meter; canvas
candlestick chart with EMA overlays and entry/stop/target lines drawn at real
price levels; multi-timeframe heatmap (15m/1h/4h/1d); per-factor evidence panels
grouped by category; derivatives card; risk/position-size calculator; backtest
card; watchlist with signal-change alerts (localStorage + Notification API).

## Delivery

Single-file `index.html` on GitHub Pages. Sources live in `src/`, concatenated by
`scripts/build.mjs` — the shipped artifact has zero dependencies and no build
step at runtime.

## Gates

* `node scripts/test_engine.mjs` — indicator math checked against
  independently-computed expected values; engine invariants (weights sum to 1,
  scores in range, no look-ahead in the backtest, stop always on the correct side
  of entry, liquidation beyond stop).
* `node scripts/verify_site.js` — jsdom boot of the built page against recorded
  live API fixtures; asserts the render path produces a verdict, factor rows,
  plan levels, and a chart draw, with no boot error.
