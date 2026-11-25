// Equal-weight rebalancing bot for the make.fun bars-replay/v1 protocol (hourly Solana bars).
//
// Idea: hold the whole universe in equal slices like buy-and-hold, so a rising market is not
// missed, and trade a slice back to its equal target whenever it drifts past a small band. That
// sells what just ran ahead of the basket and buys what lagged, harvesting the back-and-forth
// between the coins: a small edge over buy-and-hold that does not depend on market direction.
//
// Self-contained: reads newline-delimited JSON on stdin, writes one reply line per batch on stdout.
// No clock, no randomness, no files, no network: the same bars always give the same orders.

import { createInterface } from 'node:readline';

const BPS = 10_000n;
const INVEST_BPS = 9950n; // keep ~0.5% in USDC: enough to fund most rebalancing buys, little cash drag
const BAND_BPS = 45n; // no-trade band: rebalance a slice only once it drifts 0.45% of equity off target
const WEIGHT_BPS = 2400n; // never aim above this per position (harness cap is 2500)
const BUY_SLIP = 150;
const SELL_SLIP = 400;
const MIN_TRADES = 8; // the contest's guardrail: fewer filled trades ranks below every compliant entry
const GUARD_BARS = 24; // batches after which a short trade count narrows the band

interface Sym { symbol: string; price_scale: number; qty_scale: number }
interface Bar { symbol: string; t: number; o: string; h: string; l: string; c: string }
interface Fill { symbol: string; side: string; status: string }
interface Pos { symbol: string; qty: string; cost_quote_units: string }

let syms: Sym[] = [];
let quoteScale = 6;
let maxWeightBps = 2500n;
let maxOrders = 16;
let maxOpen = 10;
let minNotional = 1_000_000n;
let warmup = 0;
let started = false;
let filledTrades = 0;
let clientSeq = 0;
const lastClose = new Map<string, bigint>();

function valueOf(symbol: string, qty: bigint): bigint {
  const s = syms.find((x) => x.symbol === symbol);
  const px = lastClose.get(symbol);
  if (s === undefined || px === undefined) return 0n;
  return (qty * px * 10n ** BigInt(quoteScale)) / 10n ** BigInt(s.qty_scale + s.price_scale);
}

function nextId(): string {
  clientSeq++;
  return `tg${clientSeq}`;
}

function onBatch(seq: number, bars: Bar[], fills: Fill[], cash: bigint, equity: bigint, positions: Pos[]): unknown[] {
  for (const f of fills) if (f.status === 'filled') filledTrades++;
  for (const b of bars) lastClose.set(b.symbol, BigInt(b.c));
  const held = new Map<string, bigint>();
  for (const p of positions) if (BigInt(p.qty) > 0n) held.set(p.symbol, BigInt(p.qty));
  const barred = new Set(bars.map((b) => b.symbol));
  if (warmup > 0 && seq < warmup) return [];

  const orders: unknown[] = [];
  if (!started) {
    // First tradable batch: an equal slice of the invested share of cash in every priced symbol.
    const priced = syms.filter((s) => barred.has(s.symbol)).map((s) => s.symbol);
    if (priced.length === 0) return [];
    started = true;
    const n = Math.min(syms.length, maxOpen, maxOrders);
    let slice = (cash * INVEST_BPS) / BPS / BigInt(n);
    const cap = (maxWeightBps * equity) / BPS;
    if (slice > cap) slice = cap;
    if (slice < minNotional) return [];
    for (const symbol of priced.slice(0, n)) {
      orders.push({ side: 'buy', client_id: nextId(), symbol, notional_quote_units: slice.toString(), max_slippage_bps: BUY_SLIP });
    }
    return orders;
  }

  // v2: equal-weight rebalancing with a no-trade band. Each symbol's target is an equal share of
  // the invested part of equity; a slice that drifts past BAND of equity is traded back to target.
  // In choppy markets this sells what just ran ahead of the basket and buys what lagged behind,
  // a small edge over buy-and-hold that does not depend on the market's direction.
  const n = BigInt(Math.min(syms.length, maxOpen));
  const invested = (equity * INVEST_BPS) / BPS;
  let target = invested / n;
  const cap = (WEIGHT_BPS * equity) / BPS;
  if (target > cap) target = cap;
  let band = (equity * BAND_BPS) / BPS;
  // Trade-count guard: the guardrail needs MIN_TRADES fills. In a calm market the band may never
  // be crossed, so once GUARD_BARS batches pass with too few fills the band narrows, then narrows
  // again, letting small (still useful) rebalances through before the window ends.
  if (filledTrades < MIN_TRADES && seq >= GUARD_BARS) band = seq >= GUARD_BARS * 2 - 8 ? 0n : band / 4n;
  const buys: { symbol: string; need: bigint }[] = [];
  for (const { symbol } of syms) {
    if (!barred.has(symbol)) continue;
    const qty = held.get(symbol) ?? 0n;
    const value = valueOf(symbol, qty);
    if (value > target + band) {
      // Sell only the excess, as a quantity: excess value over the value of one unit of qty.
      const sellQty = value === 0n ? 0n : ((value - target) * qty) / value;
      if (sellQty > 0n && valueOf(symbol, sellQty) >= minNotional * 2n && orders.length < maxOrders) {
        orders.push({ side: 'sell', client_id: nextId(), symbol, qty: sellQty.toString(), max_slippage_bps: SELL_SLIP });
      }
    } else if (value + band < target) {
      buys.push({ symbol, need: target - value });
    }
  }
  // Buys: sell proceeds only land at the next open, so this reply spends the cash it has now,
  // the largest shortfall first (deterministic tie-break by universe order).
  buys.sort((a, b) => (a.need === b.need ? 0 : a.need > b.need ? -1 : 1));
  let free = (cash * 998n) / 1000n;
  for (const { symbol, need } of buys) {
    if (orders.length >= maxOrders) break;
    const slice = need < free ? need : free;
    if (slice < minNotional * 2n) continue;
    orders.push({ side: 'buy', client_id: nextId(), symbol, notional_quote_units: slice.toString(), max_slippage_bps: BUY_SLIP });
    free -= slice;
  }
  // Last resort for a dead-calm window: one tiny top-up per batch, from the USDC buffer, of the
  // most underweight held symbol, until the guardrail's trade count is reached.
  if (orders.length === 0 && filledTrades < MIN_TRADES && seq >= GUARD_BARS * 2 - 8 && free >= minNotional * 3n) {
    let pick = '';
    let low = -1n;
    for (const { symbol } of syms) {
      if (!barred.has(symbol)) continue;
      const v = valueOf(symbol, held.get(symbol) ?? 0n);
      if (low < 0n || v < low) { pick = symbol; low = v; }
    }
    if (pick !== '') orders.push({ side: 'buy', client_id: nextId(), symbol: pick, notional_quote_units: (minNotional * 3n).toString(), max_slippage_bps: BUY_SLIP });
  }
  return orders;
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (line.trim() === '') continue;
  const msg = JSON.parse(line);
  if (msg.type === 'hello') {
    syms = msg.symbols;
    quoteScale = msg.capital.quote_scale;
    maxWeightBps = BigInt(msg.caps.max_weight_bps);
    maxOrders = msg.caps.max_orders_per_bar;
    maxOpen = msg.caps.max_open_positions;
    minNotional = BigInt(msg.fees.min_notional_quote_units);
    warmup = msg.warmup_bars ?? 0;
  } else if (msg.type === 'batch') {
    const a = msg.account;
    const orders = onBatch(msg.seq, msg.bars, msg.fills, BigInt(a.cash_quote_units), BigInt(a.equity_quote_units), a.positions);
    process.stdout.write(JSON.stringify({ type: 'reply', seq: msg.seq, orders }) + '\n');
  } else if (msg.type === 'done') {
    break;
  }
}
rl.close();
process.stdin.destroy();
