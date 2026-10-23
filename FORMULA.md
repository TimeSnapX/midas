# Crypto Market Scouter: scoring rules

All numbers live in `src/config.js` (the Python mirror is `CFG` in `tools/scan.py`). Code: `src/score.js`.
Borrowed from Coin Risk vs Reward (`coin-risk-reward/src/config.js`, `FORMULA.md`): missing data never adds upside (a Heat part with no data scores 0), a risk check with no data adds **half** its points, mint/freeze authority is a hard fail, and the grade bands A ≤ 25, B ≤ 40, C ≤ 55, D > 55.

**Research only, not financial advice.** "unknown" means an API did not return the field. Nothing is guessed.

## Heat (0-100, higher = hotter)

| Part | Max | Rule (DexScreener best-liquidity pair) |
|---|---|---|
| Volume | 25 | 15 × log-scale of 1h volume ($1k → 0, $100k → 15) + 10 × acceleration, where acceleration = (5m volume × 12) / 1h volume, linear from 0.5 → 0 to 2.0 → 10 |
| Buys | 25 | 15 × 1h buy ratio buys/(buys+sells), linear from 0.50 → 0 to 0.75 → 15, + 10 × min(1, 5m buys / 50) |
| Liquidity | 20 | log scale, $5k → 0, $100k → 20 |
| Age | 15 | ramps 0 → 15 over the first 10 min, full 15 from 10 min to 6 h, fades to 5 at 24 h, 0 after |
| Holder growth | 15 | new holders per minute between RugCheck re-reads (every 5 min while the app is open), 20/min → 15. Unknown until two reads exist, so it scores 0 |

## Risk (0-100, higher = worse)

| Check | Points | Unknown |
|---|---|---|
| Mint authority enabled (RugCheck) | +30, **hard fail** | +10 |
| Freeze authority enabled (RugCheck) | +30, **hard fail** | +10 |
| LP locked or burned, liquidity-weighted over all RugCheck markets | 20 × (1 − locked%); 0 at ≥ 95% | +10 |
| Top-10 holder share, AMM/locker/pool accounts excluded | linear 20% → 0 to 50% → 20 | +10 |
| Paid DexScreener boosts (latest + top boosts) | +5 if any, +10 if ≥ 500 | 0 |
| Bot trading: ≥ 200 txns in 1h with buys and sells within 4% of each other | +8 | 0 |
| Bot trading: 1h volume > 10 × liquidity (wash churn) | +7 | 0 |
| Liquidity under $10k | +5 | +2.5 |

The total is capped at 100. A hard fail sets risk to at least 70 (grade D). Grade: A ≤ 25, B ≤ 40, C ≤ 55, D otherwise.

## "Of worth" alert

A coin is **of worth** when all of these hold (defaults, editable in the Alerts tab):
- Heat ≥ **65**
- Risk ≤ **40** (grade A or B)
- Liquidity ≥ **$10,000**
- A RugCheck report exists (mint and freeze authority are known) and neither authority is enabled.

Each coin alerts once per 24 h with an in-app toast, plus a browser notification if you allowed them. Alerts run only while the app is open.

## Trade analytics (before vs after)

- **Log trade** stores side, entry price, amount (USD), time, note and source (me / Ares / Argus / Hades pick). It freezes a BEFORE snapshot: price, market cap, liquidity, 1h and 24h volume, holders, Heat, Risk, grade and the risk flags.
- AFTER snapshots at **+5m, +1h, +24h, +7d** and at **exit** (logging a sell closes that coin's open buys at the sell price). Each one holds P/L % and $ (P/L $ needs an amount), the peak price, the max drawdown from the peak, Heat and Risk changes and any new risk flags.
- Snapshots are taken only while the app is open. If the app was closed past the grace window (+5m: 10 min, +1h: 30 min, +24h: 3 h, +7d: 12 h), the slot reads **missed (app closed)**. Peak and drawdown are what the app saw while it was open.
- Result per trade = exit P/L if closed, else the latest after snapshot. Win rate = share of results > 0. "Did Heat or Risk predict it": a median split on the BEFORE Heat (and Risk), the average result in each half, and the Pearson correlation once there are 3+ trades.
- Stored in `localStorage["cryptoscouter.v1"]`. CSV export in the Analytics tab.

## Launch Feed: first-minute quick score (0-100, higher = cleaner early signal)

**Research only.** A screen for the first minutes of a pump.fun coin, not a verdict. Numbers live in `CONFIG.launch` (`src/config.js`), code in `src/launch.js`.

Sources (all keyless): PumpPortal websocket `wss://pumpportal.fun/api/data` with `subscribeNewToken` (every pump.fun creation: mint, name, ticker, creator, dev initial buy, bonding-curve reserves) and `subscribeMigration` (graduations to PumpSwap/Raydium). PumpPortal's `subscribeTokenTrade` needs a funded API key, so early trades come from **GeckoTerminal** instead: the bonding-curve pools of up to **30 watched coins** are read in one `pools/multi` request every **20 s** (60 s back-off if rate-limited). GeckoTerminal indexes a new coin after roughly 30-60 s; until then early buys read "pending". Images come from pump.fun's image CDN. "Age" is the time since the stream delivered the creation (normally under a second after the on-chain create).

| Part | Max | Rule |
|---|---|---|
| Dev initial buy | 20 | 0.1-3 SOL → 20; other non-zero buys up to 5 SOL → 10. **Flag** and 0 if the dev bought **0 SOL**, or **> 5 SOL**, or **> 20 %** of supply |
| Serial launcher | 15 | 15 if this creator wallet has launched only this coin since the page opened. **Flag** and 0 (on all its coins) once it launches a second one |
| Name / ticker | 15 | 15 if clean. **Flag** and 0 for: empty name or ticker, ticker > 10 chars, 4+ repeated characters, digits-only ticker or a link in the name, a famous ticker or name (SOL, BONK, WIF, PEPE, TRUMP, ELON, DOGE… list in config), or the same ticker or name as an earlier launch this session (copycat) |
| Early buy velocity | 30 | Read once from GeckoTerminal's 5-minute counters while the coin is ≤ 2 min old: 18 × min(1, buys / 20) + 12 × min(1, 5m volume / $1,500). Unknown (not watched, or not indexed in time) → 0 |
| Bonding-curve progress | 20 | progress = (1,073,000,000 − virtual tokens in curve) / (1,073,000,000 − 279,900,000); 20 × min(1, progress / 25 %). Taken from the create event (it includes the dev buy) and set to 100 % on graduation |

A coin is **flagged** if any flag fires; "Hide flagged" removes them. Watch slots (30) go to new coins without a zero-dev / serial / spam / empty-name flag; when full, the lowest quick score watched for at least 60 s is swapped out, and coins stop being watched after 5 min. Memory keeps the newest **500** launches.

**Promotion to the Radar:** every 30 s the top 30 unflagged launches older than 60 s are looked up on DexScreener in one request; any with a pair join the Radar (and stay 30 min) where the full Heat/Risk scores apply. Up to 2 more per cycle are tried on RugCheck; a report also promotes the coin.

**Filters and alerts:** keyword (name, ticker, CA or creator), hide flagged, minimum early buys, minimum quick score. The optional sound and/or browser notification fires once per coin when a launch passes your filters, only if at least one filter is set, and at most once every 5 s. Pause closes the websocket (launches during a pause are not captured); Resume reconnects.

## Best Performers

Keyless, cached in `localStorage["cryptoscouter.best.v1"]` until you press Refresh (auto-refresh after 30 min when the tab opens). Requests are spaced (CoinGecko 1.5 s, GeckoTerminal 2.5 s, RugCheck 0.7 s).
- CoinGecko `coins/markets` for the `pump-fun` and `solana-meme-coins` categories (top 100 each by market cap): market cap, ATH price and date, drawdown from ATH, 7d and 30d change. `coins/list?include_platform=true` maps them to Solana mints (cached).
- **ATH market cap = ATH price × current circulating supply** (a derivation, shown as such).
- GeckoTerminal top PumpSwap and Raydium pools by 24h volume add coins CoinGecko doesn't list (no ATH, so unknown).
- DexScreener tokens: **launch date = earliest pair still listed** (can be later than the real launch, then age at ATH reads unknown), total liquidity, and migration (a PumpSwap/Raydium/Meteora/Orca pair).
- Holders from RugCheck for the top 10 only.
- **Multiple from launch is always "unknown"**: no keyless source gives the launch price.
- "What they had in common" summarises only the coins shown: median age at ATH, liquidity range and liquidity/mcap, share launched on pump.fun, share migrated and median drawdown. It is a small, survivor-biased sample.
