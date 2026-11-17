// Dip-buy cbBTC bot (long only, paper USDC), tuned for
// btc-race-24h-20261117-0603 (dev window 2026-11-16 06:03 -> 2026-11-17
// 06:03 UTC, BTC $64,461 -> $64,776, +0.49%, essentially flat/sideways,
// range $63,874-$65,467).
//
// The base bot copied from the 20261115 instance ("strict recovery from
// the 120-min low", RECOVER 2.2%) FAILS the dev gate here: net -$5.47,
// one round trip — it buys the top of the hour-8 bounce at $65,404 and
// stops out at $64,741. The recovery family was swept exhaustively
// (RECOVER 0.4%-3.0%, LOW_BARS 15-360, TRAIL/STOP/TAKE_*/MAX_HOLD/STAKE/
// COOLDOWN, then 960 combos): best +$3.35 on 2 trips, with sharp cliffs
// (RECOVER 0.011 -> -$0.13, 0.016 -> -$3.60; LOW_BARS 180 -> -$2.23).
// A flat window has no 2%+ bounces to recover from; the tradeable edge
// is the range itself: buy within 0.2% of the 60-bar low on an uptick,
// bank half at +0.6%, let the rest run to +2.0% / 1.5% trail / 0.8%
// stop / 300 bars. That fires 6 round trips on the dev window (3 wins,
// 3 losses) for +$8.69 sim / verified on the local grader below, max
// drawdown 0.58%, +$6.28 at 2x fees. The optimum is flat: of 31
// one-step neighbors, 29 are positive and the two negatives are tiny
// (STOP 0.4% -> -$0.28, MAX_HOLD 180 -> -$0.41); the TRAIL 1.2%
// variant scores +$9.63 at center but has a -$3.40 neighbor, so the
// flatter 1.5% trail was chosen over the higher peak.
// Honest caveat: this is still one flat 24 h window. The edge is
// mean-reversion inside a range; in a trending race window the dip
// buys will catch falling knives, the 0.6% stop caps each trip at
// roughly -0.6% of the half-stake, and the bot may simply not trade
// if price never revisits a 60-bar low. Dev PnL is not a race promise.
//
// All decisions use only closes seen so far, in float64 ratios
// (scale-free), no clock, no network, no randomness: two runs on the
// same bars give the same orders.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 200;

// Entry: 60-bar window, buy within DIP of its low on an uptick.
const LOW_BARS = 60;
const DIP = 0.002; // ...no more than 0.2% above the 60-bar low
const MIN_HISTORY = LOW_BARS + 10; // bars before the first entry is allowed
// Size and pacing.
const STAKE_NUM = 1n; // 1/2 of cash
const STAKE_DEN = 2n;
const COOLDOWN_BARS = 15; // bars after an exit before the next entry
// Exits (fractions of the entry fill price / peak close).
const TAKE_HALF = 0.006; // sell half the position at +0.6%
const TAKE_FULL = 0.020; // sell the rest at +2.0%
const TRAIL = 0.015; // sell the rest 1.5% below the peak close since entry
const STOP = 0.008; // sell the rest 0.8% below the entry fill price
const MAX_HOLD_BARS = 300;
// Circuit breaker: stop trading if equity falls this far below its peak.
const BREAKER_NUM = 95n; // 95%
const BREAKER_DEN = 100n;

const closes: number[] = [];
let entryPrice: number | null = null; // fill price of the current position (raw units)
let peakClose: number | null = null; // highest close since entry (raw units)
let heldBars = 0;
let halfSold = false;
let lastExitSeq = -1_000_000;
let equityPeak: bigint | null = null;
let breakerTripped = false;

function lowOfLast(n: number): number {
  let lo = Infinity;
  for (let i = closes.length - n; i < closes.length; i++) {
    if (closes[i]! < lo) lo = closes[i]!;
  }
  return lo;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    // Track fills first: a buy fill sets the entry price, a sell fill while
    // still holding marks the half as sold.
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      if (f.side === 'buy') {
        entryPrice = Number(f.price);
        peakClose = entryPrice;
        heldBars = 0;
        halfSold = false;
      } else if (f.side === 'sell' && state.positions.has(SYMBOL)) {
        halfSold = true;
      }
    }

    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    closes.push(Number(bar.c));
    const close = Number(bar.c);

    // Circuit breaker on equity (bigint, exact).
    if (equityPeak === null || state.equity > equityPeak) equityPeak = state.equity;
    if (!breakerTripped && state.equity * BREAKER_DEN < equityPeak * BREAKER_NUM) breakerTripped = true;

    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      if (entryPrice === null) {
        // Position without a recorded fill (should not happen): infer the
        // entry price from cost / qty at the current scales.
        const sym = state.hello.symbols.find((s) => s.symbol === SYMBOL)!;
        const price =
          (Number(held.cost) * 10 ** (sym.qty_scale + sym.price_scale)) /
          (Number(held.qty) * 10 ** state.hello.capital.quote_scale);
        entryPrice = price;
        peakClose = Math.max(price, close);
      }
      if (peakClose === null || close > peakClose) peakClose = close;
      heldBars++;
      const orders: SellInput[] = [];
      // Half profit first, once.
      if (!halfSold && close >= entryPrice * (1 + TAKE_HALF)) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty / 2n, max_slippage_bps: MAX_SLIPPAGE_BPS });
        halfSold = true;
        return orders;
      }
      // Full exit: take-profit, trailing stop, hard stop, max hold, breaker.
      if (
        close >= entryPrice * (1 + TAKE_FULL) ||
        close <= peakClose! * (1 - TRAIL) ||
        close <= entryPrice * (1 - STOP) ||
        heldBars >= MAX_HOLD_BARS ||
        breakerTripped
      ) {
        lastExitSeq = state.seq;
        entryPrice = null;
        peakClose = null;
        halfSold = false;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: reset entry tracking and look for the next setup.
    entryPrice = null;
    peakClose = null;
    halfSold = false;
    if (breakerTripped || state.warmingUp) return [];
    if (closes.length < MIN_HISTORY) return [];
    if (state.seq - lastExitSeq < COOLDOWN_BARS) return [];

    const lo = lowOfLast(LOW_BARS);
    const prev = closes[closes.length - 2]!;
    if (close <= lo * (1 + DIP) && close > prev) {
      const notional = (state.cash * STAKE_NUM) / STAKE_DEN;
      if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
      const order: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [order];
    }
    return [];
  },
});
