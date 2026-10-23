# Midas strategy rules

Midas's job: **find the best coins using Crypto Market Scouter and Argus × Hades, paper-trade first, and make no real trade without approval for each one.**
Nothing here is financial advice. Memecoins can go to zero.

## 1. Universe and data
- Scanner = the Crypto Market Scouter pipeline (commit 943ca3e): DexScreener profiles/boosts + GeckoTerminal new pools → DexScreener pairs → RugCheck reports.
- Scores = Scouter Heat (0–100) and Risk (0–100, higher = worse); see FORMULA.md. Missing data never adds upside.
- Argus × Hades = `https://timesnapx.github.io/argus-hades-live/public/feed.json` (fallback `/feed.json`). If unreachable the app says **not reachable** and shows nothing invented.

## 2. Entry rule ("of worth", all must hold)
| Rule | Default |
|---|---|
| Heat | ≥ 65 |
| Risk | ≤ 40 |
| Liquidity | ≥ $10,000 |
| Mint authority | revoked (confirmed by RugCheck; unknown = no entry) |
| Freeze authority | revoked (confirmed by RugCheck; unknown = no entry) |
| RugCheck "rugged" | false |
| Live price | available |

An **Argus pick is a signal, not an override**: it is ranked first among candidates but only entered if it passes every rule above.

## 3. Exits — DEFAULTS TO REVIEW (editable in Settings)
- Stop-loss: **−25%** from entry (default, review).
- Take-profit: **+60%** from entry (default, review).
- Paper positions auto-close at SL/TP while the app is open (checked every scan and every 15 s). If the app is closed, nothing closes.
- Live positions only **alert** at SL/TP; selling needs your Phantom signature.

## 4. Sizing
- Paper: $1,000 starting balance, **10% of equity** per trade (default, review), max **5** open, no re-entry into the same coin for 120 min.
- Live: per-trade cap **5% of the wallet's SOL balance** (default), checked before a quote is built and again right before the signature is requested.

## 5. Paper first, live only with per-trade approval
1. Default mode is PAPER. Auto-paper (optional, off by default) enters every coin that passes §2 within §4 limits.
2. Live trading is **OFF by default**; turning it on needs an explicit confirm dialog with a risk acknowledgement.
3. Every live swap is built with the free Jupiter quote/swap API and **signed by you in Phantom**. Midas never auto-signs, never asks for a seed phrase or private key, and stores no keys.
4. **Daily loss limit: 12%** of the wallet's SOL balance at the first reading of the Brisbane day (allowed 10–15%). Losses = realized SOL losses today + mark-to-market losses on live positions opened today. When hit: live switches off, the app is in paper mode, and live is **locked until the next day in Australia/Brisbane time**. Exit sells of existing live positions stay possible (they still need your signature).

## 7. Wallet connection and live feeds (v2)
- On load Midas silently checks for Phantom's injected provider (`window.phantom.solana` / `window.solana`) with `connect({ onlyIfTrusted: true })`, and, if a Portal App ID is set, the SDK's `autoConnect()`. It listens for `connect`, `disconnect` and `accountChanged`.
- Chrome on Android cannot see the Phantom mobile app's wallet. Use **Open in Phantom** (opens Midas in Phantom's in-app browser), or Google/Apple embedded login with an App ID. Seed phrases and private keys are never asked for or stored.
- Wallet transactions: RPC websocket `logsSubscribe` (publicnode) triggers fetches; `getSignaturesForAddress` + `getTransaction` (jsonParsed) every 8 s (30 s while the websocket is open), with exponential backoff up to 60 s. Classified from balance changes; unclear = "unknown".
- Market trades: GeckoTerminal pool trades for the top 5 watched coins, one pool every 10 s, through a limiter shared with the scanner (15 req/min, 30 s pause after a 429).
