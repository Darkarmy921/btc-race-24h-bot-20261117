# btc-race-24h-20261117-0603 — dip-buy bot

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/Darkarmy921/btc-race-24h-bot-20261117/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/Darkarmy921/btc-race-24h-bot-20261117/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A bot for make.fun's "Race a BTC trading bot live for 24 hours" — see the bounty at https://make.fun/bounty/btc-race-24h-20261117-0603.

## Strategy: buy the dip inside the range

The dev window (2026-11-16 06:03 → 2026-11-17 06:03 UTC, BTC $64,461 →
$64,776, +0.49%, range $63,874–$65,467) is essentially flat/sideways.
The base bot copied from the 20261115 instance — "strict recovery from
the 120-min low", entry on a 2.2% recovery — FAILS the dev gate here:
net **-$5.47**, one round trip: it buys the top of the hour-8 bounce at
$65,404 and stops out at $64,741. A flat window has no 2%+ bounces to
recover from, so the recovery family was swept exhaustively (960
combos) and tops out at +$3.35 on 2 trips, with sharp cliffs. The
tradeable edge in this window is the range itself:

- **Entry:** the close is within 0.2% of the lowest close of the last
  60 bars and closes up on the bar. Stake is 50% of cash.
- **Exits:** sell half at +0.6% over the entry fill, sell the rest at
  +2.0%, on a 1.5% trailing stop from the peak close, on a 0.8% hard
  stop, or after 300 bars, whichever comes first.
- **Safety:** a 5% equity circuit breaker stops all trading for the
  rest of the window (far inside the 25% race drawdown guardrail).
  15-bar cooldown after each exit. Max slippage 200 bps per order.

## Final config (bot/main.ts)

| Param | Value |
| --- | --- |
| LOW_BARS | 60 |
| DIP | 0.002 (0.2% above the 60-bar low) |
| MIN_HISTORY | 70 (LOW_BARS + 10) |
| STAKE | 1/2 of cash |
| COOLDOWN_BARS | 15 |
| TAKE_HALF | 0.006 (+0.6%) |
| TAKE_FULL | 0.020 (+2.0%) |
| TRAIL | 0.015 (1.5% below peak close) |
| STOP | 0.008 (0.8% below entry fill) |
| MAX_HOLD_BARS | 300 |
| BREAKER | 95% of equity peak |
| MAX_SLIPPAGE_BPS | 200 |

## Dev-grade result (local grader, process driver)

Command (from `kit/`):
`node cli/makefun.mjs grade-local --kit . --bot <bot-dir> --driver process --json`

- Net PnL **+$8.69** (+0.87%), fees $2.42, **+$6.27 at 2x fees**
- 16 fills, 6 round trips (5 completed + 1 open at window end,
  flattened), win rate 0.50 (3 wins / 3 losses on completed trips)
- Max drawdown **0.58%** (limit 25%), Sharpe 0.0274, Sortino 0.0434
- Constraints compliant; result_sha256
  `822aebf21169afdcfb63ce0da240fd567e3b206fa1ff6e53652fe8e5c79823a4`
- Determinism: graded twice, identical result_sha256 and
  action_log_sha256; L1 reproduced true.
- **Dev gate: PASSES** (net PnL > $0, margin +$8.69 vs the +$3 target).

Trips (fill price → exit price): $64,456→$63,952 (-0.78%),
$63,960→$65,218 (+1.97%), $64,362→$64,941 (+0.90%),
$65,001→$64,429 (-0.88%), $64,532→$64,902 (+0.57%),
$64,861→$64,727 flattened (-0.21%).

## Robustness (neighbor table, ±1 step, fast sim validated to ≤$0.01 of the grader)

Of 31 one-step neighbors, 29 are positive; the two negatives are tiny
(STOP 0.4% → -$0.28, verified on the real grader as -$0.29;
MAX_HOLD 180 → -$0.41). Full table in `work/trials.md`. The TRAIL 1.2%
variant scores +$9.63 at center but has a -$3.40 neighbor, so the
flatter 1.5% trail was chosen over the higher peak. STAKE 0.75/1.0
score higher on this window (+$11.40/+$13.52) but were NOT taken: stake
interacts with exits through price impact, and the 50% stake keeps
dev drawdown at 0.58% with the validated neighbor table.

## Honest caveats

- One flat 24 h window. The edge is mean-reversion inside a range; in
  a trending race window the dip buys catch falling knives. Each trip's
  loss is capped by the 0.8% stop / 1.5% trail on a half-stake, so a
  bad window costs a few percent, not the account — but it can still
  easily end negative. Dev PnL is not a race promise.
- The 6th trip only exists because an entry fired 10 bars before the
  window end and was flattened; on the live window that trade would
  have had room to play out.
- MAX_HOLD is the bumpiest parameter (120 → +$0.32, 180 → -$0.41,
  240 → +$3.96, 300 → +$8.69, 360 → +$0.38, 600 → +$8.48): the 300-bar
  cap times two exits well on this window. Treat it as the weakest
  link in the config.

## Files

- `main.ts` — the bot (Node 22, erasable TypeScript, stdlib only)
- `main-base.ts` — the 20261115 base bot, kept for the record (not an
  entrypoint; do not ship it as one)
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's
  bars-replay/v1 SDK shim (untouched)
- `README-base-20261115.md` — the base bot's notes (old slug)

## Run

Grade locally with the kit (from the kit directory):

```
node cli/makefun.mjs grade-local --kit . --bot /path/to/bot --driver process
```
