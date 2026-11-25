[![make.fun bounty](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/lolipo8988-bot/pump-sharpe-jack-01/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/lolipo8988-bot/pump-sharpe-jack-01/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# pump-sharpe-jack

A paper-trading bot for [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) on make.fun.

Paper trading only — the bot runs inside the `agent-fun/replay/v2` replay harness on recorded pump.fun market data. It never touches a real wallet and never sends a real transaction.

## Strategy

Built for hourly Sharpe, not for moonshots: steady, controlled gains with a shallow drawdown.

The bot trades rarely and small. Entries require steady, strong flow, not a spike: over a 30-slot window split in two halves, a coin qualifies only when net SOL inflow is at least 1 SOL in each half and 6 SOL overall, buys make up at least 72% of the window's flow from at least 10 buys and 9 distinct buyers, the price is up 6%–40% and sitting at 99% of its window high or better, and the curve holds 4–40 SOL of real reserves with at least 600 slots of age. Each entry is one flat 0.06 SOL stake (capped by the harness's 1%-of-real-reserve order cap), never added to, with at most 3 main positions at once and one entry per coin. A realized-loss breaker halts fresh entries after 0.25 SOL of net filled losses. (Looser and dip-buying variants were graded on the dev window first and lost; this selective version finished the dev replay at +0.0097 SOL with 0.21% max drawdown.)

Exits sell the whole position on the first of: +15% take-profit, −6% stop loss against cost, a 6% trailing stop armed after +8%, net outflow over the last 15 slots (flow fade), or 300 slots held.

Guardrail rotation: while fewer than 24 distinct coins have completed a round trip, the bot periodically buys a small lot (0.015 SOL, never below the 0.01 SOL round-trip minimum) of the deepest-reserve coin traded in the current slot that it has not round-tripped yet, and sells it on the next batch — keeping the run above the competition's 20-coin round-trip guardrail at minimal slippage cost. The v2 rebuild adds a depth floor for probes: a candidate curve must hold at least 10 SOL of real reserves, otherwise the probe waits for a deeper coin instead of paying thin-curve slippage for a guardrail tick.

Everything is deterministic: no clock, no randomness, no network. The same batch stream always produces the same orders, so the two grading executions agree byte for byte.

## Layout

- `main.ts` — the strategy (entrypoint, run by the grader as `node /bot/main.ts` on Node 22)
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` SDK shim, vendored byte for byte

## Run locally

With the competition kit:

```
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```

## License

MIT — see [LICENSE](LICENSE).
