# Midas · Crypto Trader (PWA)
Live: https://timesnapx.github.io/midas/  — **Not financial advice.**

- **Scanner**: Crypto Market Scouter data + scoring (DexScreener, GeckoTerminal, RugCheck; Heat/Risk, see FORMULA.md) with the STRATEGY.md entry rule.
- **Argus × Hades** signals from the argus-hades-live feed (shown as "not reachable" if it is down; never faked).
- **Paper portfolio** (`localStorage["midas.v1"]`): $1,000, live-price entries, SL/TP auto-close while open, P&L, trade log, CSV export, optional auto-paper.
- **Live mode** (OFF by default): Phantom Connect via `@phantom/browser-sdk` (bundled in `vendor/phantom-vendor.js`, loaded only when you connect). The injected provider (Phantom extension / Phantom in-app browser) needs no App ID. For Google/Apple embedded wallets, create an app at https://phantom.com/portal, allowlist `https://timesnapx.github.io/midas/`, and paste the App ID in Settings (or `MIDAS.phantomAppId` in `src/config.js`). Swaps: Jupiter lite-api quote/swap, signed by you in Phantom. Per-trade cap 5% of wallet SOL, daily loss limit 12% (10–15%) with a Brisbane-day lock.
- PWA: manifest id `/midas/?app=midas`, network-first SW for the same-origin shell only (no API/RPC/Phantom/websocket caching), install button `js/install.js`.

Vendor bundle: `npm i @phantom/browser-sdk@2.0.4 @solana/web3.js && esbuild vendor.js --bundle --format=esm --minify --define:global=globalThis` where vendor.js re-exports `BrowserSDK, AddressType, waitForPhantomExtension` and `VersionedTransaction`.
