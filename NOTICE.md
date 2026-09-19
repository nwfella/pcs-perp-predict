# Notice

The MIT license in `LICENSE` covers the source code in this repository. The
notes below sit outside that grant and outside the warranty disclaimer, but they
describe what this software is and is not.

## Market data

Market data accessed by this software is provided by **Aster**
(<https://www.asterdex.com>) and **PancakeSwap**
(<https://pancakeswap.finance>) under their own terms of service. This project
reads their public endpoints; it is unaffiliated with, and not endorsed by,
either.

## Not financial advice

This software is a market-data analysis tool. It:

- places no orders,
- holds no private keys and signs nothing,
- moves no funds.

It performs a transparent, rule-based summary of public market data. It does not
forecast prices, and its own validation — reproduced by the scripts in
`scripts/` and summarised in the README — found **no statistically significant
edge** in any of the weight profiles shipped. Perpetual futures traded with
leverage can lose your entire margin and more. Nothing here is a recommendation
to trade. Verify every level yourself before risking capital.

## No warranty of accuracy

Levels, scores and statistics are derived from third-party endpoints that can be
delayed, rate-limited, revised or wrong. The exchange's own contract
specifications (`tickSize`, `stepSize`, `minQty`) should be treated as
authoritative over anything displayed here.
