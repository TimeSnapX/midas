// Keyless public APIs, called straight from the browser. Every field that an API does not return stays null ("unknown").
import { CONFIG as C } from "./config.js";
export const apiStatus = {}; // name -> {ok, at, err}
async function get(name, url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), C.timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: "no-store", headers: { accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json(); apiStatus[name] = { ok: true, at: Date.now() }; return j;
  } catch (e) { apiStatus[name] = { ok: false, at: Date.now(), err: e.name === "AbortError" ? "timeout" : e.message }; return null; }
  finally { clearTimeout(t); }
}
const n = (v) => (v === null || v === undefined || v === "" || isNaN(+v) ? null : +v);

export async function dsProfiles() {
  const j = await get("DexScreener profiles", "https://api.dexscreener.com/token-profiles/latest/v1");
  return (Array.isArray(j) ? j : []).filter((x) => x.chainId === "solana").map((x) => ({ mint: x.tokenAddress, src: "profile", icon: x.icon || null, links: x.links || [] }));
}
export async function dsBoosts() {
  const out = new Map();
  for (const [name, u] of [["DexScreener boosts", "https://api.dexscreener.com/token-boosts/latest/v1"], ["DexScreener top boosts", "https://api.dexscreener.com/token-boosts/top/v1"]]) {
    const j = await get(name, u);
    for (const x of Array.isArray(j) ? j : []) if (x.chainId === "solana") out.set(x.tokenAddress, Math.max(out.get(x.tokenAddress) || 0, n(x.totalAmount) || n(x.amount) || 0));
  }
  return out;
}
export async function gtNewPools(pages = 2) {
  const out = [];
  for (let p = 1; p <= pages; p++) {
    const j = await get("GeckoTerminal new pools", `https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=${p}`);
    for (const d of j?.data || []) { const id = d.relationships?.base_token?.data?.id || ""; const mint = id.replace(/^solana_/, "");
      if (mint && mint !== "So11111111111111111111111111111111111111112") out.push({ mint, src: "gt-new", gtPool: d.attributes?.address, gtCreated: Date.parse(d.attributes?.pool_created_at) || null }); }
  }
  return out;
}
// Best (highest liquidity) Solana pair per mint, 30 mints per request.
export async function dsTokens(mints) {
  const best = new Map();
  for (let i = 0; i < mints.length; i += 30) {
    const j = await get("DexScreener token pairs", "https://api.dexscreener.com/tokens/v1/solana/" + mints.slice(i, i + 30).join(","));
    for (const p of Array.isArray(j) ? j : []) { const m = p.baseToken?.address; if (!m) continue;
      const cur = best.get(m); if (!cur || (n(p.liquidity?.usd) || 0) > (n(cur.liquidity?.usd) || 0)) best.set(m, p); }
  }
  return best;
}
export function pairToCoin(p) {
  return {
    mint: p.baseToken.address, symbol: p.baseToken.symbol || null, name: p.baseToken.name || null, pair: p.pairAddress, dex: p.dexId || null,
    priceUsd: n(p.priceUsd), mcap: n(p.marketCap) ?? null, fdv: n(p.fdv), liq: n(p.liquidity?.usd),
    volM5: n(p.volume?.m5), volH1: n(p.volume?.h1), volH24: n(p.volume?.h24),
    buysM5: n(p.txns?.m5?.buys), sellsM5: n(p.txns?.m5?.sells), buysH1: n(p.txns?.h1?.buys), sellsH1: n(p.txns?.h1?.sells),
    chgM5: n(p.priceChange?.m5), chgH1: n(p.priceChange?.h1), chgH24: n(p.priceChange?.h24),
    createdAt: n(p.pairCreatedAt), image: p.info?.imageUrl || null, socials: [...(p.info?.websites || []).map((w) => ({ type: "web", url: w.url })), ...(p.info?.socials || [])],
    dsUrl: p.url || `https://dexscreener.com/solana/${p.pairAddress}`,
  };
}
export async function rugReport(mint) {
  const d = await get("RugCheck", `https://api.rugcheck.xyz/v1/tokens/${mint}/report`);
  if (!d) return null;
  const known = d.knownAccounts || {}; const skip = new Set();
  for (const [a, v] of Object.entries(known)) if (/AMM|LOCKER/i.test(v?.type || "")) skip.add(a);
  let lockedUsd = 0, totUsd = 0;
  for (const m of d.markets || []) { [m.pubkey, m.liquidityAAccount, m.liquidityBAccount].forEach((a) => typeof a === "string" && skip.add(a));
    const lp = m.lp || {}; const t = (n(lp.baseUSD) || 0) + (n(lp.quoteUSD) || 0); totUsd += t; lockedUsd += t * ((n(lp.lpLockedPct) || 0) / 100); }
  const holders = (d.topHolders || []).filter((h) => !skip.has(h.address) && !skip.has(h.owner));
  return {
    mintAuthority: d.mintAuthority || null, freezeAuthority: d.freezeAuthority || null,
    lpLockedPct: totUsd > 0 ? (lockedUsd / totUsd) * 100 : null,
    top10Pct: (d.topHolders || []).length ? holders.slice(0, 10).reduce((a, h) => a + (n(h.pct) || 0), 0) : null,
    holders: n(d.totalHolders), rugScore: n(d.score_normalised), rugged: !!d.rugged, rugRisks: (d.risks || []).map((r) => r.name), at: Date.now(),
  };
}
export async function ohlcv(pair) {
  const j = await get("GeckoTerminal OHLCV", `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pair}/ohlcv/minute?aggregate=5&limit=144`);
  return (j?.data?.attributes?.ohlcv_list || []).map((r) => ({ t: r[0] * 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] })).reverse();
}
export async function argusFeed() { for (const u of C.feedUrls) { const j = await get("Argus × Hades feed", u + "?t=" + Date.now()); if (j) { j._url = u; return j; } } return null; }
