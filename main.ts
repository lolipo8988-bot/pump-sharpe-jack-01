// pump-sharpe-jack: a paper-trading bot for the pump.fun replay
// (protocol agent-fun/replay/v2), tuned for the Sharpe sprint.
//
// Paper trading only: the harness replays recorded market data, so this bot
// never touches a real wallet and never sends a real transaction.
//
// Strategy in one line: trade rarely and small — one flat stake only in a
// coin whose buy flow is strong and steady across both halves of a short
// window, quick profit-taking and a tight stop, plus the minimum rotation
// needed for the round-trip guardrail; on pump.fun curves most flow is
// noise, so the Sharpe comes from refusing almost every trade, keeping the
// equity curve smooth and the drawdown shallow.
//
// (Two earlier builds of this bot were graded on the dev window and rebuilt:
// a looser steady-flow version traded ~70 times and lost a little, and a
// dip-buying reversion version traded ~100 times and lost a lot. Both said
// the same thing — fee drag and bad fills punish activity — so this version
// keeps the steady-flow entry but raises every bar until only a handful of
// trades survive it.)
//
// Wire shape, briefly: hello carries the caps for this run (open positions,
// per-order size as a share of a curve's real reserve, orders per batch).
// After hello, each batch is one slot of chain events, fills for earlier
// orders and marks; the bot answers the batch with the orders it wants for
// that slot. Everything is deterministic — no clock, no randomness, no
// network — so two runs over the same stream emit identical orders.

import { runBot, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const SOL = 1_000_000_000;

// ---- entry: steady, strong flow over a 30-slot window, in two halves ----
const WINDOW = 30; // slots of tape used for the entry decision
const HALF = 15; // each half of the window must show real net inflow
const MIN_AGE_SLOTS = 600; // ignore a coin until its curve has some history
const MIN_BUYS = 10;
const MIN_DISTINCT_BUYERS = 9;
const MIN_NET_SOL = 6; // net inflow across the full window
const MIN_HALF_NET_SOL = 1; // net inflow in each half (the steadiness test)
const MIN_BUY_SHARE = 0.72; // buys must dominate the window's SOL flow
const MIN_RISE = 0.06; // price gain across the window: at least +6% ...
const MAX_RISE = 0.4; // ... but never chase a vertical +40% spike
const NEAR_HIGH = 0.99; // price must sit at 99% of the window high or better
const MIN_RESERVE_SOL = 4; // real SOL reserve band for entries
const MAX_RESERVE_SOL = 40;
const STAKE_SOL = 0.06; // one flat stake per coin, never added to
const MIN_ORDER_SOL = 0.02;
const BUY_SLIPPAGE_BPS = 1200;
const MAX_MAIN_POSITIONS = 3; // leave slots free for rotation probes
const REENTRY_COOLDOWN = 1200; // slots before a coin may be entered again
const MAX_ENTRIES_PER_COIN = 1;

// ---- exits: bank a real gain, cut a loss early, never overstay ----
const TAKE_PROFIT = 0.15;
const STOP_LOSS = 0.06;
const TRAIL_ARM = 0.08;
const TRAIL_DROP = 0.06;
const MAX_HOLD_SLOTS = 300;
const FADE_WINDOW = 15; // slots watched for momentum dying
const FADE_OUTFLOW_SOL = 1.2;
const LOSS_BREAKER_SOL = 0.25; // realized loss that halts fresh main entries

// ---- guardrail rotation: round trips on at least 20 distinct mints ----
const TARGET_ROUND_TRIPS = 24;
const PROBE_SOL = 0.015; // above the 0.01 SOL round-trip minimum, fee-aware
const PROBE_SPACING = 300; // slots between probes while under target
// v2 rebuild revision (post-open session review): a probe only pays off if
// its round-trip cost stays tiny, and cost is set by curve depth. The old
// code picked the deepest coin touched this slot but would still probe a
// shallow curve on a quiet slot, paying full slippage for a guardrail tick.
// Require a real depth floor instead: skip the probe this slot and wait for
// a deeper candidate rather than buying into a thin curve.
const PROBE_MIN_RESERVE_SOL = 10;

interface TapeTrade {
  slot: number;
  isBuy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface CoinTape {
  createdSlot: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExitSlot: number;
}

interface OpenTrade {
  openedSlot: number;
  peakValueSol: number;
  costSeen: boolean;
  exitSent: boolean;
}

const tapes = new Map<Pubkey, CoinTape>();
const openTrades = new Map<Pubkey, OpenTrade>();
const probes = new Set<Pubkey>();
const roundTripped = new Set<Pubkey>();
let lastProbeSlot = -1_000_000;
let buySpendSol = 0; // SOL out on filled buys, fees included
let sellIncomeSol = 0; // SOL back on filled sells

function tapeFor(mint: Pubkey): CoinTape {
  let tape = tapes.get(mint);
  if (tape === undefined) {
    tape = { createdSlot: null, trades: [], entries: 0, lastExitSlot: -1_000_000 };
    tapes.set(mint, tape);
  }
  return tape;
}

// The steadiness test: flow must be strong in both halves of the window,
// buy-dominated overall, and the price rising gently at its window high.
function steadyFlow(tape: CoinTape, now: number, reserveSol: number): boolean {
  if (reserveSol < MIN_RESERVE_SOL || reserveSol > MAX_RESERVE_SOL) return false;
  if (tape.createdSlot === null || now - tape.createdSlot < MIN_AGE_SLOTS) return false;
  const split = now - HALF;
  const from = now - WINDOW;
  let netEarly = 0;
  let netLate = 0;
  let buyFlow = 0;
  let totalFlow = 0;
  let buys = 0;
  let firstPrice = 0;
  let lastPrice = 0;
  let highPrice = 0;
  const buyers = new Set<string>();
  for (const trade of tape.trades) {
    if (trade.slot <= from) {
      firstPrice = trade.price;
      continue;
    }
    if (firstPrice === 0) firstPrice = trade.price;
    const signed = trade.isBuy ? trade.sol : -trade.sol;
    if (trade.slot <= split) netEarly += signed;
    else netLate += signed;
    totalFlow += trade.sol;
    if (trade.isBuy) {
      buyFlow += trade.sol;
      buys += 1;
      buyers.add(trade.user);
    }
    if (trade.price > highPrice) highPrice = trade.price;
    lastPrice = trade.price;
  }
  if (buys < MIN_BUYS || buyers.size < MIN_DISTINCT_BUYERS) return false;
  if (netEarly < MIN_HALF_NET_SOL || netLate < MIN_HALF_NET_SOL) return false;
  if (netEarly + netLate < MIN_NET_SOL) return false;
  if (totalFlow <= 0 || buyFlow / totalFlow < MIN_BUY_SHARE) return false;
  if (firstPrice <= 0 || highPrice <= 0) return false;
  const rise = lastPrice / firstPrice - 1;
  if (rise < MIN_RISE || rise > MAX_RISE) return false;
  if (lastPrice < highPrice * NEAR_HIGH) return false;
  return true;
}

// Estimated liquidation value of a position, net of curve fees and the tx fee.
function liquidationValue(state: BotState, mint: Pubkey): number | null {
  const pos = state.positions.get(mint);
  const curve = state.curves.get(mint);
  if (pos === undefined || curve === undefined) return null;
  const tokens = Number(pos.token_amount);
  const gross = (tokens * Number(curve.virtual_quote_reserves)) / (Number(curve.virtual_token_reserves) + tokens);
  return gross / SOL * (1 - 0.0125) - Number(state.txFeeLamports()) / SOL;
}

await runBot({
  onBatch(state, batch) {
    const now = batch.slot;
    const orders: OrderInput[] = [];
    const orderCap = state.hello.caps.max_orders_per_batch;
    const txFeeSol = Number(state.txFeeLamports()) / SOL;
    const touched = new Set<Pubkey>();

    // Fills bookkeeping: track realized flow and completed round trips.
    for (const fill of batch.fills) {
      if (fill.status !== 'filled' || fill.client_id.startsWith('_')) continue;
      const lamports = Number(fill.quote_lamports) / SOL;
      if (fill.side === 'buy') buySpendSol += lamports;
      else {
        sellIncomeSol += lamports;
        roundTripped.add(fill.mint);
      }
    }
    const realizedSol = sellIncomeSol - buySpendSol;
    const entriesHalted = realizedSol < -LOSS_BREAKER_SOL;

    // Fold this slot's events into the per-coin tapes.
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        tapeFor(event.mint).createdSlot = event.slot;
      } else if (event.event === 'TradeEvent') {
        tapeFor(event.mint).trades.push({
          slot: event.slot,
          isBuy: event.is_buy,
          sol: Number(event.sol_amount) / SOL,
          user: event.user,
          price: Number(event.virtual_quote_reserves) / Number(event.virtual_token_reserves),
        });
        touched.add(event.mint);
      }
    }
    // Keep only the tape the entry and fade tests can still read.
    for (const mint of touched) {
      const tape = tapes.get(mint)!;
      let drop = 0;
      while (drop < tape.trades.length && tape.trades[drop]!.slot <= now - WINDOW - 5) drop += 1;
      if (drop > 0) tape.trades.splice(0, drop);
    }

    const pendingMints = new Set<Pubkey>();
    const pendingSells = new Set<Pubkey>();
    for (const pending of state.pending.values()) {
      pendingMints.add(pending.order.mint);
      if (pending.order.side === 'sell') pendingSells.add(pending.order.mint);
    }

    // 1) Exits before entries: the first trigger that fires sells everything.
    for (const [mint, open] of openTrades) {
      const pos = state.positions.get(mint);
      if (pos === undefined) {
        if (!pendingMints.has(mint)) {
          openTrades.delete(mint);
          const tape = tapeFor(mint);
          if (open.costSeen) tape.lastExitSlot = now;
          else tape.entries -= 1;
        }
        continue;
      }
      open.costSeen = true;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const value = liquidationValue(state, mint);
      if (value === null) continue;
      if (value > open.peakValueSol) open.peakValueSol = value;
      const cost = Number(pos.cost_lamports) / SOL;
      let shouldExit = open.exitSent;
      const tape = tapes.get(mint);
      if (tape !== undefined) {
        let recentNet = 0;
        for (let i = tape.trades.length - 1; i >= 0; i -= 1) {
          const trade = tape.trades[i]!;
          if (trade.slot <= now - FADE_WINDOW) break;
          recentNet += trade.isBuy ? trade.sol : -trade.sol;
        }
        if (recentNet < -FADE_OUTFLOW_SOL) shouldExit = true;
      }
      if (value >= cost * (1 + TAKE_PROFIT)) shouldExit = true;
      if (value <= cost * (1 - STOP_LOSS)) shouldExit = true;
      if (open.peakValueSol >= cost * (1 + TRAIL_ARM) && value <= open.peakValueSol * (1 - TRAIL_DROP)) shouldExit = true;
      if (now - open.openedSlot >= MAX_HOLD_SLOTS) shouldExit = true;
      if (!shouldExit || pendingSells.has(mint) || orders.length >= orderCap) continue;
      open.exitSent = true;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
    }

    // 2) Probe exits: a rotation position is sold on the first batch after it lands.
    for (const mint of [...probes]) {
      const pos = state.positions.get(mint);
      if (pos === undefined) {
        if (!pendingMints.has(mint)) probes.delete(mint);
        continue;
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete || pendingMints.has(mint) || orders.length >= orderCap) continue;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
    }

    // 3) Entries: one flat stake in a steady-flow coin, nothing more.
    let freeSol = Number(state.freeCashLamports()) / SOL;
    let slotsFree = state.hello.caps.max_open_positions - state.committedPositionCount();
    if (!entriesHalted) {
      for (const mint of touched) {
        if (orders.length >= orderCap || slotsFree <= 0) break;
        if (openTrades.size >= MAX_MAIN_POSITIONS) break;
        if (openTrades.has(mint) || probes.has(mint) || pendingMints.has(mint)) continue;
        if (state.positions.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const tape = tapes.get(mint)!;
        if (tape.entries >= MAX_ENTRIES_PER_COIN) continue;
        if (now - tape.lastExitSlot < REENTRY_COOLDOWN) continue;
        const reserveSol = Number(curve.real_quote_reserves) / SOL;
        if (!steadyFlow(tape, now, reserveSol)) continue;
        const capSol = Number(state.maxBuyLamports(mint)) / SOL;
        let amount = Math.min(capSol, STAKE_SOL);
        if (amount > freeSol - txFeeSol) amount = freeSol - txFeeSol;
        if (amount < MIN_ORDER_SOL) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: BigInt(Math.floor(amount * SOL)),
          max_slippage_bps: BUY_SLIPPAGE_BPS,
        });
        freeSol -= amount + txFeeSol;
        slotsFree -= 1;
        tape.entries += 1;
        openTrades.set(mint, { openedSlot: now, peakValueSol: 0, costSeen: false, exitSent: false });
      }
    }

    // 4) Rotation probes: until enough distinct coins have round-tripped,
    // buy a small lot of the deepest coin touched this slot and let step 2
    // sell it next batch. Deep reserves keep the probe's slippage tiny.
    if (
      roundTripped.size < TARGET_ROUND_TRIPS &&
      now - lastProbeSlot >= PROBE_SPACING &&
      slotsFree > 0 &&
      probes.size === 0 &&
      orders.length < orderCap
    ) {
      let bestMint: Pubkey | null = null;
      let bestReserve = 0n;
      for (const mint of touched) {
        if (roundTripped.has(mint) || openTrades.has(mint) || pendingMints.has(mint)) continue;
        if (state.positions.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (Number(curve.real_quote_reserves) / SOL < PROBE_MIN_RESERVE_SOL) continue;
        if (curve.real_quote_reserves > bestReserve) {
          bestReserve = curve.real_quote_reserves;
          bestMint = mint;
        }
      }
      if (bestMint !== null) {
        const capSol = Number(state.maxBuyLamports(bestMint)) / SOL;
        const amount = Math.min(capSol, PROBE_SOL);
        if (amount >= 0.01 && freeSol >= amount + 2 * txFeeSol) {
          orders.push({
            side: 'buy',
            mint: bestMint,
            quote_lamports: BigInt(Math.floor(amount * SOL)),
            max_slippage_bps: BUY_SLIPPAGE_BPS,
          });
          probes.add(bestMint);
          lastProbeSlot = now;
        }
      }
    }

    return orders;
  },
});
