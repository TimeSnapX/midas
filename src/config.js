// Midas (reused from Crypto Market Scouter 943ca3e): every number used by the scores and alerts. See FORMULA.md.
// Ideas reused from /workspace/coin-risk-reward/src/config.js: unknown data never adds upside,
// a failed risk source adds HALF the rule's points, grades A<=25 B<=40 C<=55 D, hard fails on authorities.
export const CONFIG = {
  refreshSec: 45,                 // radar refresh (30-60 s)
  maxCoins: 80,                   // coins kept on the radar
  rugcheckPerCycle: 10,           // RugCheck reports fetched per refresh (top-heat coins first)
  rugcheckTtlSec: 300,            // re-check a coin's RugCheck report after 5 min
  timeoutMs: 9000,
  heatWeights: { volume: 25, buys: 25, liquidity: 20, age: 15, holders: 15 },
  heat: {
    volH1Lo: 1000, volH1Hi: 100000,      // log scale, $1k -> 0, $100k -> full (15 of the 25)
    accelLo: 0.5, accelHi: 2.0,          // m5 volume x12 / h1 volume (10 of the 25)
    buyRatioLo: 0.5, buyRatioHi: 0.75,   // h1 buys/(buys+sells) (15 of the 25)
    m5BuysHi: 50,                        // m5 buy count for full marks (10 of the 25)
    liqLo: 5000, liqHi: 100000,          // log scale
    ageRampMin: 10, ageSweetMaxH: 6, ageFadeMaxH: 24, // full 10 min-6 h, fades to 1/3 at 24 h, 0 after
    holderGrowthPerMinHi: 20,            // new holders per minute (seen across RugCheck re-checks)
  },
  riskPoints: { mint: 30, freeze: 30, lp: 20, top10: 20, boosts: 10, bots: 15, lowLiq: 5 },
  unknownFactor: 0.5,             // missing data => half the rule's points (authorities: 10 each, see below)
  authorityUnknownPoints: 10,
  risk: { lpSafePct: 95, top10Lo: 20, top10Hi: 50, boostBig: 500, washTxMin: 200, washImbalanceMax: 0.04, volLiqMax: 10, lowLiqUsd: 10000 },
  grades: [{ g: "A", max: 25 }, { g: "B", max: 40 }, { g: "C", max: 55 }, { g: "D", max: 100 }],
  worth: { minHeat: 65, maxRisk: 40, minLiqUsd: 10000 }, // "of worth" alert defaults (editable in Filters)
  snapshots: [{ k: "+5m", ms: 5 * 60e3 }, { k: "+1h", ms: 3600e3 }, { k: "+24h", ms: 86400e3 }, { k: "+7d", ms: 7 * 86400e3 }],
  snapshotGraceMs: { "+5m": 10 * 60e3, "+1h": 30 * 60e3, "+24h": 3 * 3600e3, "+7d": 12 * 3600e3 }, // later than this => "missed (app closed)"
  storageKey: "midas.scan.v1",
  // Launch Feed (PumpPortal websocket) + first-minute quick score. See FORMULA.md "Launch Feed".
  launch: {
    wsUrl: "wss://pumpportal.fun/api/data",
    maxCoins: 500,                 // memory cap: oldest launches are dropped
    maxShown: 120,                 // cards rendered at once
    tradeSubCap: 30,               // early-trade watch list size (GeckoTerminal pools/multi, one request)
    tradePollSec: 20,              // GeckoTerminal poll (its free limit is ~30 req/min, shared with the radar)
    tradeSubMaxAgeSec: 300,        // stop watching trades after 5 min
    tradeSubMinHoldSec: 60,        // a watched coin can't be swapped out before 60 s
    devBuy: { goodLoSol: 0.1, goodHiSol: 3, bigSol: 5, bigSupplyPct: 20 }, // 0 SOL or > bigSol / > bigSupplyPct% of supply => flag
    velocity: { windowSec: 60, buysHi: 20, volUsdHi: 1500 },                // 5m buys/volume read within the first 2 min (GeckoTerminal)
    curveHiPct: 25,                // bonding-curve progress for full marks
    curveTokens: { start: 1073000000, end: 279900000 }, // pump.fun virtual tokens at launch and at graduation
    weights: { dev: 20, serial: 15, name: 15, velocity: 30, curve: 20 },
    famous: ["SOL", "BTC", "ETH", "BONK", "WIF", "PEPE", "TRUMP", "MELANIA", "ELON", "DOGE", "SHIB", "POPCAT", "MEW", "PNUT", "GOAT", "FARTCOIN", "PENGU", "JUP", "USDC", "USDT", "BOME", "MOODENG", "AI16Z", "SPX", "GIGA", "MICHI", "CHILLGUY", "PUMP"],
    promoteEverySec: 30,           // check DexScreener for the top launches this often
    promoteMinAgeSec: 60, promotePerCycle: 30, rugcheckPerCycle: 2,
    alertMinGapSec: 5,             // at most one sound/notification per 5 s
  },
  feedUrls: ["https://timesnapx.github.io/argus-hades-live/public/feed.json", "https://timesnapx.github.io/argus-hades-live/feed.json"],
};

// Midas: paper portfolio, strategy defaults and live-trading guard rails. See STRATEGY.md.
// The SL/TP/size numbers are DEFAULTS TO REVIEW, all editable in Settings.
export const MIDAS = {
  storageKey: "midas.v1",
  tz: "Australia/Brisbane",
  paper: { startUsd: 1000, sizePct: 10, maxOpen: 5, reentryCooldownMin: 120 },
  strategy: { minHeat: 65, maxRisk: 40, minLiqUsd: 10000, requireAuthoritiesRevoked: true, stopLossPct: 25, takeProfitPct: 60 },
  priceTickSec: 15,                 // open-position price check (DexScreener) while the app is open
  live: { capPct: 5, dailyLossPct: 12, dailyLossMin: 10, dailyLossMax: 15, slippageBps: 300 },
  // Phantom Connect. The injected provider (Phantom extension / Phantom in-app browser) needs no app ID.
  // Google/Apple embedded wallets need an App ID from https://phantom.com/portal : paste it here or in Settings.
  phantomAppId: "",
  rpcUrl: "https://solana-rpc.publicnode.com", // read-only balance lookups; editable in Settings
  jupiter: { quote: "https://lite-api.jup.ag/swap/v1/quote", swap: "https://lite-api.jup.ag/swap/v1/swap", price: "https://lite-api.jup.ag/price/v3" },
  SOL: "So11111111111111111111111111111111111111112",
};
