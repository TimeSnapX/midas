// Midas: scanner (Crypto Market Scouter scoring) + Argus × Hades signals + paper portfolio + opt-in Phantom-signed live swaps.
import { CONFIG as C, MIDAS as M } from "./config.js";
import { heatScore, riskScore } from "./score.js";
import * as A from "./api.js";
import * as W from "./wallet.js";
import * as L from "./live.js";

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const U = "unknown";
const usd = (v) => v === null || v === undefined || isNaN(v) ? U : Math.abs(v) >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "M" : Math.abs(v) >= 1e3 ? "$" + (v / 1e3).toFixed(1) + "k" : "$" + (+v).toFixed(2);
const price = (v) => v === null || v === undefined || isNaN(v) ? U : v >= 1 ? "$" + v.toFixed(4) : "$" + v.toPrecision(4);
const pct = (v, d = 1) => v === null || v === undefined || isNaN(v) ? U : (v > 0 ? "+" : "") + v.toFixed(d) + "%";
const cls = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");
const ago = (ms) => { if (!ms) return U; const m = (Date.now() - ms) / 60e3; return m < 60 ? Math.max(0, Math.round(m)) + "m" : m < 1440 ? (m / 60).toFixed(1) + "h" : (m / 1440).toFixed(1) + "d"; };
const bneDay = (t = Date.now()) => new Intl.DateTimeFormat("en-CA", { timeZone: M.tz }).format(new Date(t)); // YYYY-MM-DD in Brisbane
const bneTime = (t) => new Date(t).toLocaleString("en-AU", { timeZone: M.tz, dateStyle: "short", timeStyle: "medium" }) + " AEST";
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------- state: localStorage "midas.v1" ----------
const DEF = () => ({ v: 1, cash: M.paper.startUsd, start: M.paper.startUsd, positions: [], log: [], entered: {},
  settings: { sl: M.strategy.stopLossPct, tp: M.strategy.takeProfitPct, sizePct: M.paper.sizePct, maxOpen: M.paper.maxOpen, autoPaper: false,
    live: false, capPct: M.live.capPct, dailyLossPct: M.live.dailyLossPct, slippageBps: M.live.slippageBps, appId: M.phantomAppId, rpc: M.rpcUrl },
  liveDay: { day: null, startSol: null, lossSol: 0 }, liveLockDay: null, livePositions: [], liveLog: [] });
let S; try { S = JSON.parse(localStorage.getItem(M.storageKey)); } catch {}
S = Object.assign(DEF(), S || {}); S.settings = Object.assign(DEF().settings, S.settings || {}); S.settings.live = S.settings.live === true;
const save = () => localStorage.setItem(M.storageKey, JSON.stringify(S));
save();

// ---------- scanner (same pipeline + scores as Crypto Market Scouter) ----------
const coins = new Map(), rugCache = new Map();
let tab = "scanner", feed = null, refreshing = false, lastRefresh = 0, walletSol = null, solPrice = null;
function score(c) {
  const r = rugCache.get(c.mint);
  if (r?.report) Object.assign(c, r.report, { rug: true });
  if (r?.hist?.length >= 2) { const a = r.hist[0], b = r.hist[r.hist.length - 1]; if (b.t > a.t && a.holders !== null && b.holders !== null) c.holderGrowthPerMin = (b.holders - a.holders) / ((b.t - a.t) / 60e3); }
  c.ageMin = c.createdAt ? (Date.now() - c.createdAt) / 60e3 : null;
  c.heat = heatScore(c); c.risk = riskScore(c); c.entry = entryCheck(c); c.worth = c.entry.ok;
}
// STRATEGY.md entry rule: Heat >= 65, Risk <= 40, liquidity >= $10k, mint AND freeze authority confirmed revoked (RugCheck), not rugged.
function entryCheck(c) {
  const s = M.strategy, why = [];
  if (!c.heat || c.heat.score < s.minHeat) why.push(`Heat ${c.heat?.score ?? U} < ${s.minHeat}`);
  if (!c.risk || c.risk.score > s.maxRisk) why.push(`Risk ${c.risk?.score ?? U} > ${s.maxRisk}`);
  if (!(c.liq >= s.minLiqUsd)) why.push(`Liquidity ${usd(c.liq)} < ${usd(s.minLiqUsd)}`);
  if (!c.rug) why.push("Authorities not verified yet (RugCheck)"); else { if (c.mintAuthority) why.push("Mint authority enabled"); if (c.freezeAuthority) why.push("Freeze authority enabled"); if (c.rugged) why.push("RugCheck: rugged"); }
  if (!c.priceUsd) why.push("No live price");
  return { ok: !why.length, why };
}
async function refresh() {
  if (refreshing) return; refreshing = true; setStatus("Scanning…");
  try {
    const [profiles, boosts, gt] = await Promise.all([A.dsProfiles(), A.dsBoosts(), A.gtNewPools(2)]);
    const seeds = new Map(); for (const x of [...gt, ...profiles]) if (!seeds.has(x.mint)) seeds.set(x.mint, x);
    for (const m of boosts.keys()) if (!seeds.has(m)) seeds.set(m, { mint: m, src: "boost" });
    const picks = (feed?.argus?.picks || []).map((p) => p.ca).filter(Boolean);
    const tracked = new Set([...S.positions.map((p) => p.mint), ...S.livePositions.map((p) => p.mint), ...picks]);
    const mints = [...new Set([...tracked, ...seeds.keys(), ...coins.keys()])].slice(0, 150);
    const pairs = await A.dsTokens(mints);
    for (const [m, p] of pairs) { const c = Object.assign(coins.get(m) || {}, A.pairToCoin(p)); c.boosts = boosts.get(m) ?? c.boosts ?? 0; c.src = c.src || seeds.get(m)?.src || "tracked"; coins.set(m, c); }
    for (const c of coins.values()) score(c);
    const keep = [...coins.values()].sort((a, b) => b.heat.score - a.heat.score).slice(0, C.maxCoins).map((c) => c.mint);
    for (const m of [...coins.keys()]) if (!keep.includes(m) && !tracked.has(m)) coins.delete(m);
    const need = [...coins.values()].filter((c) => { const r = rugCache.get(c.mint); return !r || Date.now() - r.report.at > C.rugcheckTtlSec * 1000; })
      .sort((a, b) => (tracked.has(b.mint) - tracked.has(a.mint)) || b.heat.score - a.heat.score).slice(0, C.rugcheckPerCycle);
    for (let i = 0; i < need.length; i += 3) await Promise.all(need.slice(i, i + 3).map(async (c) => {
      const rep = await A.rugReport(c.mint); if (!rep) return;
      const r = rugCache.get(c.mint) || { hist: [] }; r.report = rep; r.hist.push({ t: rep.at, holders: rep.holders }); r.hist = r.hist.slice(-12); rugCache.set(c.mint, r);
    }));
    for (const c of coins.values()) score(c);
    lastRefresh = Date.now(); checkExits(); autoPaper();
    setStatus(`Live · ${coins.size} coins · ${[...coins.values()].filter((c) => c.worth).length} entry-ready · ${new Date().toLocaleTimeString("en-AU", { timeZone: M.tz })} AEST`);
  } catch (e) { console.warn(e); setStatus("Scan failed: " + e.message); }
  refreshing = false; render();
}
// Open-position price ticks between scans (DexScreener, positions only).
async function tickPrices() {
  const mints = [...new Set([...S.positions, ...S.livePositions].map((p) => p.mint))]; if (!mints.length) return;
  const pairs = await A.dsTokens(mints);
  for (const [m, p] of pairs) { const c = Object.assign(coins.get(m) || {}, A.pairToCoin(p)); coins.set(m, c); if (!c.heat) score(c); }
  checkExits(); if (tab === "portfolio") render();
}
const priceOf = (mint) => coins.get(mint)?.priceUsd ?? null;

// ---------- paper portfolio ----------
function paperBuy(mint, usdAmt, src = "manual") {
  const c = coins.get(mint); const p = c?.priceUsd;
  if (!p) return toast("No live price for this coin, so no paper entry.");
  usdAmt = Math.min(+usdAmt, S.cash); if (!(usdAmt > 0)) return toast("Not enough paper cash.");
  const pos = { id: uid(), mint, symbol: c.symbol || U, entry: p, qty: usdAmt / p, cost: usdAmt, sl: S.settings.sl, tp: S.settings.tp, at: Date.now(), src, heat: c.heat?.score ?? null, risk: c.risk?.score ?? null };
  S.cash -= usdAmt; S.positions.push(pos); S.entered[mint] = Date.now();
  S.log.push({ t: pos.at, side: "BUY", id: pos.id, mint, symbol: pos.symbol, price: p, qty: pos.qty, usd: usdAmt, pnl: null, reason: src });
  save(); toast(`📄 Paper BUY ${pos.symbol} ${usd(usdAmt)} @ ${price(p)} (SL -${pos.sl}% / TP +${pos.tp}%)`); render(); return pos;
}
function paperSell(id, reason = "manual") {
  const i = S.positions.findIndex((x) => x.id === id); if (i < 0) return;
  const pos = S.positions[i], p = priceOf(pos.mint);
  if (!p) return toast("No live price right now; can't close at a real price.");
  const val = pos.qty * p, pnl = val - pos.cost; S.cash += val; S.positions.splice(i, 1);
  S.log.push({ t: Date.now(), side: "SELL", id: pos.id, mint: pos.mint, symbol: pos.symbol, price: p, qty: pos.qty, usd: val, pnl, reason });
  save(); toast(`📄 Paper SELL ${pos.symbol} ${usd(val)} (${pnl >= 0 ? "+" : ""}${usd(pnl)}) · ${reason}`); render();
}
function checkExits() {
  for (const pos of [...S.positions]) { const p = priceOf(pos.mint); if (!p) continue; const ch = (p / pos.entry - 1) * 100;
    if (ch <= -pos.sl) paperSell(pos.id, `stop-loss ${ch.toFixed(1)}%`); else if (ch >= pos.tp) paperSell(pos.id, `take-profit +${ch.toFixed(1)}%`); }
  for (const lp of S.livePositions) { const p = priceOf(lp.mint); if (!p || lp.alerted) continue; const ch = (p / lp.entry - 1) * 100;
    if (ch <= -S.settings.sl || ch >= S.settings.tp) { lp.alerted = true; save(); toast(`🔔 LIVE ${lp.symbol} hit ${ch <= 0 ? "stop-loss" : "take-profit"} (${pct(ch)}). Open Portfolio to sell; you must sign it in Phantom.`); } }
}
function autoPaper() {
  if (!S.settings.autoPaper) return;
  const cool = M.paper.reentryCooldownMin * 60e3;
  const cands = [...coins.values()].filter((c) => c.worth && !S.positions.some((p) => p.mint === c.mint) && !(Date.now() - (S.entered[c.mint] || 0) < cool))
    .sort((a, b) => (isPick(b.mint) - isPick(a.mint)) || (b.heat.score - b.risk.score) - (a.heat.score - a.risk.score));
  for (const c of cands) { if (S.positions.length >= S.settings.maxOpen) break; const amt = equity() * S.settings.sizePct / 100; if (amt > S.cash || amt < 1) break; paperBuy(c.mint, amt, "auto-paper" + (isPick(c.mint) ? " (Argus pick)" : "")); }
}
const isPick = (mint) => (feed?.argus?.picks || []).some((p) => p.ca === mint);
const equity = () => S.cash + S.positions.reduce((a, p) => a + p.qty * (priceOf(p.mint) ?? p.entry), 0);
function csv() {
  const rows = [["time_aest", "side", "symbol", "mint", "price_usd", "qty", "usd", "pnl_usd", "reason", "mode"]];
  for (const l of S.log) rows.push([bneTime(l.t), l.side, l.symbol, l.mint, l.price, l.qty, l.usd?.toFixed(2), l.pnl === null ? "" : l.pnl.toFixed(2), l.reason, "paper"]);
  for (const l of S.liveLog) rows.push([bneTime(l.t), l.side, l.symbol, l.mint, l.price ?? "", l.qty ?? "", l.usd ?? "", "", (l.sig || "") + " " + (l.note || ""), "live"]);
  const b = new Blob([rows.map((r) => r.map((x) => `"${String(x ?? "").replace(/"/g, '""')}"`).join(",")).join("\n")], { type: "text/csv" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = `midas-trades-${bneDay()}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- live guard rails ----------
function rollDay() { const d = bneDay(); if (S.liveDay.day !== d) S.liveDay = { day: d, startSol: walletSol, lossSol: 0 }; if (S.liveDay.startSol === null && walletSol !== null) S.liveDay.startSol = walletSol; if (S.liveLockDay && S.liveLockDay !== d) S.liveLockDay = null; save(); }
const liveLocked = () => { rollDay(); return !!S.liveLockDay; };
const capSol = () => (walletSol === null ? null : walletSol * S.settings.capPct / 100);
const dailyLimitSol = () => (S.liveDay.startSol ? S.liveDay.startSol * S.settings.dailyLossPct / 100 : null);
function dailyLossSol() { // realized losses today + open live positions opened today marked to market (losses only)
  let l = S.liveDay.lossSol || 0;
  for (const p of S.livePositions) if (bneDay(p.at) === S.liveDay.day) { const px = priceOf(p.mint); if (px) l += Math.max(0, p.sol * (1 - px / p.entry)); }
  return l;
}
function enforceDaily() {
  const lim = dailyLimitSol(); if (lim === null) return false;
  if (dailyLossSol() >= lim) { S.settings.live = false; S.liveLockDay = bneDay(); save(); toast(`⛔ Daily loss limit (${S.settings.dailyLossPct}%) hit. Switched to PAPER; live mode locked until tomorrow (Brisbane).`); render(); return true; }
  return false;
}
let balErr = null, balAt = 0;
async function refreshWallet(quiet) {
  if (!W.wallet.address) { renderBadge(); return; }
  try { walletSol = await W.solBalance(S.settings.rpc, W.wallet.address); balErr = null; balAt = Date.now(); } catch (e) { balErr = e.message; if (!quiet) toast("RPC balance failed: " + e.message); }
  if (!solPrice || !quiet) solPrice = await W.solUsd(); rollDay(); renderBadge();
  if (!quiet || tab === "live" || tab === "settings" && !document.activeElement?.matches?.("input")) render();
}
const short = (a) => (a ? a.slice(0, 4) + "…" + a.slice(-4) : U);
const balTxt = () => (walletSol === null ? "balance unknown" : walletSol.toFixed(4) + " SOL");
function renderBadge() {
  const b = $("#walletBadge"); if (!b) return; const a = W.wallet.address;
  b.className = "pill " + (a ? "good" : "mid"); b.dataset.connected = a ? "1" : "0";
  b.textContent = a ? `● Connected ${short(a)} · ${balTxt()}` : W.injectedProvider() ? "Wallet: not connected" : "Wallet: no Phantom here";
}
// Explains WHY the wallet may not appear, plus the right button for this browser.
function walletHelp() {
  const a = W.wallet.address, inj = !!W.injectedProvider(), link = W.phantomBrowseLink(location.origin + location.pathname);
  if (a) return `<div class="wbox ok"><span class="pill good big-pill" id="connBadge">● Connected</span> <code title="${esc(a)}">${esc(short(a))}</code> · <b id="connBal">${balTxt()}</b>${solPrice && walletSol !== null ? " (" + usd(walletSol * solPrice) + ")" : ""} <small class="mut">via ${esc(W.wallet.via)} · balance from RPC, refreshed every 30 s${balAt ? ", last " + new Date(balAt).toLocaleTimeString("en-AU", { timeZone: M.tz }) + " AEST" : ""}${balErr ? " · RPC error: " + esc(balErr) : ""}</small>
    <div class="row" style="margin-top:6px"><button class="btn small" id="connect">Refresh balance</button><button class="btn small ghost" id="disconnect">Disconnect</button></div></div>`;
  if (inj) return `<div class="wbox"><span class="pill mid">Not connected</span> Phantom is available in this browser. <button class="btn small" id="connect">Connect Phantom</button></div>`;
  return `<div class="wbox"><span class="pill mid">No Phantom wallet in this browser</span>
    <p><b>Why your wallet doesn't show:</b> ${W.isMobile() ? "Chrome on Android (and other phone browsers) cannot see the Phantom <i>mobile app's</i> wallet, even when Phantom says it is connected. The app's wallet only exists inside Phantom's own in-app browser." : "There is no Phantom extension in this browser."} Midas can use it in two ways: open Midas <b>inside Phantom's browser</b> (button below), or use Phantom's embedded <b>Google/Apple login</b>, which needs a Phantom Portal App ID (Connection settings). Midas never asks for a seed phrase or private key.</p>
    <div class="row"><a class="btn" id="openPhantom" href="${esc(link)}" rel="noopener">Open in Phantom</a>${S.settings.appId ? '<button class="btn ghost" id="connect">Log in with Google (Phantom)</button>' : '<button class="btn ghost" id="connect">Try connect</button>'}</div></div>`;
}
const BNE = (t) => (t ? new Date(t).toLocaleString("en-AU", { timeZone: M.tz, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) + " AEST" : U);
const amt = (v) => (v === null || v === undefined || isNaN(v) ? U : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(2) + "M" : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(2) + "k" : Math.abs(v) >= 1 ? v.toFixed(3) : v.toPrecision(3));
const tok = (m) => (m ? `<a href="https://solscan.io/token/${esc(m)}" target="_blank" rel="noopener">${esc(L.sym(m) || short(m))}</a>` : U);
function txRows() {
  const f = L.txFeed;
  if (!f.addr) return '<p class="mut">Connect a wallet to see its transactions.</p>';
  const head = `<small>${esc(f.addr === W.wallet.address ? "Connected wallet" : "Watching")} <code>${esc(short(f.addr))}</code> · RPC ${esc(f.rpc)} · websocket: <b>${esc(f.wsState)}</b> · polling every ${Math.round((f.wsState === "open" ? Math.max(30000, f.interval) : f.interval) / 1000)} s${f.lastPoll ? " · last " + BNE(f.lastPoll) : ""}${f.err ? ` · <span class="neg">RPC error: ${esc(f.err)} (backing off)</span>` : ""}</small>`;
  if (!f.list.length) return head + `<p class="mut">${f.lastPoll ? "No transactions found." : "Loading transactions…"}</p>`;
  return head + `<table id="txTable"><tr><th>Time</th><th>Type</th><th>Token</th><th>Amount</th><th>For</th><th></th></tr>${f.list.map((x) => `<tr data-kind="${esc(x.kind)}"><td><small>${BNE(x.t)}</small></td><td><span class="pill ${x.kind === "buy" ? "good" : x.kind === "sell" ? "bad" : x.kind === "unknown" || x.kind === "failed" ? "mid" : ""}">${esc(x.kind)}</span></td><td>${x.main ? tok(x.main.mint) : U}</td><td class="${cls(x.main?.delta)}">${x.main ? (x.main.delta > 0 ? "+" : "") + amt(x.main.delta) : U}</td><td>${x.quote ? amt(Math.abs(x.quote.delta)) + " " + tok(x.quote.mint) : x.kind === "transfer" ? (x.main?.delta > 0 ? "in" : "out") : ""}</td><td><a href="https://solscan.io/tx/${esc(x.sig)}" target="_blank" rel="noopener">Solscan</a></td></tr>`).join("")}</table>`;
}
function mktRows() {
  const k = L.mkt;
  const head = `<small>GeckoTerminal /pools/{pool}/trades, rotating one pool every 10 s across the top ${k.pools.length || 5} watched coins (${k.pools.map((c) => esc(c.symbol || short(c.mint))).join(", ") || "waiting for scan"}). Shares the GeckoTerminal limiter with the scanner (${A.gtLimiter.max} req/min).${k.err ? ` <span class="neg">Last error: ${esc(k.err)}</span>` : ""}</small>`;
  if (!k.list.length) return head + '<p class="mut">Loading trades…</p>';
  return head + `<table id="mktTable"><tr><th>Time</th><th>Coin</th><th>Side</th><th>USD</th><th>Price</th><th>Trader</th></tr>${k.list.slice(0, 80).map((x) => `<tr><td><small>${BNE(x.t)}</small></td><td>${esc(x.symbol || short(x.mint))}</td><td><span class="pill ${x.kind === "buy" ? "good" : x.kind === "sell" ? "bad" : "mid"}">${esc(x.kind || U)}</span></td><td>${usd(x.usd)}</td><td>${price(x.price)}</td><td>${x.trader ? `<a href="https://solscan.io/account/${esc(x.trader)}" target="_blank" rel="noopener">${esc(short(x.trader))}</a>` : U}</td><td>${x.sig ? `<a href="https://solscan.io/tx/${esc(x.sig)}" target="_blank" rel="noopener">tx</a>` : ""}</td></tr>`).join("")}</table>`;
}
async function liveBuy(mint) {
  const c = coins.get(mint);
  if (!S.settings.live) return toast("Live trading is OFF (Settings).");
  if (liveLocked()) return toast("Live mode is locked until tomorrow (Brisbane) after the daily loss limit.");
  if (!W.wallet.address) return toast("Connect Phantom first (Settings).");
  await refreshWallet(); if (enforceDaily()) return;
  const cap = capSol(); if (!cap) return toast("Wallet SOL balance unknown, so the per-trade cap can't be enforced. No trade.");
  const amt = await ask(`<h2>LIVE buy ${esc(c?.symbol || mint)}</h2><p class="mut">${c?.entry?.ok ? "Passes the entry rules." : "⚠ Does NOT pass the entry rules: " + esc((c?.entry?.why || []).join("; "))}</p>
    <label>SOL to spend <input id="q-amt" type="number" step="0.001" min="0" max="${cap}" value="${(cap).toFixed(4)}"></label><p class="mut">Per-trade cap: ${cap.toFixed(4)} SOL (${S.settings.capPct}% of ${walletSol.toFixed(4)} SOL). Daily loss so far ${dailyLossSol().toFixed(4)} / ${dailyLimitSol()?.toFixed(4) ?? U} SOL.</p><p><b>Not financial advice.</b> You will sign this swap in Phantom.</p>`, "Build swap", () => +$("#q-amt").value);
  if (!amt) return;
  if (amt > cap + 1e-9) return toast(`Blocked: ${amt} SOL is over the per-trade cap of ${cap.toFixed(4)} SOL.`);
  if (enforceDaily()) return;
  try {
    const { quote, b64 } = await W.buildSwap({ inputMint: M.SOL, outputMint: mint, amount: String(Math.floor(amt * 1e9)), slippageBps: S.settings.slippageBps });
    if (!(await ask(`<h2>Confirm LIVE swap</h2><p>${amt} SOL → ~${quote.outAmount} raw units of ${esc(c?.symbol || mint)} via Jupiter (price impact ${(+quote.priceImpactPct * 100).toFixed(2)}%, slippage ${S.settings.slippageBps / 100}%).</p><p>Phantom will open; review and sign there, or reject.</p>`, "Open Phantom to sign"))) return;
    if (amt > capSol() + 1e-9 || enforceDaily()) return toast("Blocked by cap / daily limit re-check.");
    const sig = await W.signAndSend(b64);
    S.livePositions.push({ id: uid(), mint, symbol: c?.symbol || U, entry: c?.priceUsd ?? null, sol: amt, at: Date.now(), sig: String(sig) });
    S.liveLog.push({ t: Date.now(), side: "LIVE BUY", mint, symbol: c?.symbol || U, price: c?.priceUsd, usd: solPrice ? (amt * solPrice).toFixed(2) : "", sig: String(sig), note: amt + " SOL" });
    save(); toast("✅ Sent. Signature " + String(sig).slice(0, 12) + "…"); refreshWallet();
  } catch (e) { toast("Live buy cancelled/failed: " + e.message); }
}
async function liveSell(id) {
  const lp = S.livePositions.find((x) => x.id === id); if (!lp) return;
  if (!W.wallet.address) return toast("Connect Phantom first (Settings).");
  try {
    const { raw } = await W.tokenBalanceRaw(S.settings.rpc, W.wallet.address, lp.mint);
    if (raw <= 0n) { if (await ask(`<p>No ${esc(lp.symbol)} balance found in the wallet. Remove this position from the list?</p>`, "Remove")) { S.livePositions = S.livePositions.filter((x) => x !== lp); save(); render(); } return; }
    const { quote, b64 } = await W.buildSwap({ inputMint: lp.mint, outputMint: M.SOL, amount: raw.toString(), slippageBps: S.settings.slippageBps });
    const outSol = +quote.outAmount / 1e9;
    if (!(await ask(`<h2>Confirm LIVE sell</h2><p>All ${esc(lp.symbol)} → ~${outSol.toFixed(4)} SOL via Jupiter. Phantom will open for your signature.</p><p><b>Not financial advice.</b></p>`, "Open Phantom to sign"))) return;
    const sig = await W.signAndSend(b64);
    rollDay(); if (bneDay(lp.at) === S.liveDay.day) S.liveDay.lossSol += Math.max(0, lp.sol - outSol);
    S.livePositions = S.livePositions.filter((x) => x !== lp);
    S.liveLog.push({ t: Date.now(), side: "LIVE SELL", mint: lp.mint, symbol: lp.symbol, price: priceOf(lp.mint), usd: solPrice ? (outSol * solPrice).toFixed(2) : "", sig: String(sig), note: "~" + outSol.toFixed(4) + " SOL" });
    save(); toast("✅ Sell sent."); enforceDaily(); refreshWallet();
  } catch (e) { toast("Live sell cancelled/failed: " + e.message); }
}

// ---------- UI ----------
function setStatus(t) { $("#status").textContent = t; }
function toast(text) { const t = document.createElement("div"); t.className = "toast"; t.textContent = text; t.onclick = () => t.remove(); $("#toasts").prepend(t); setTimeout(() => t.remove(), 9000); }
function ask(html, okText, getVal) {
  return new Promise((res) => { const d = $("#modal");
    d.innerHTML = `<form method="dialog">${html}<div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn ghost" value="no" id="m-no">Cancel</button><button class="btn" value="ok" id="m-ok">${esc(okText)}</button></div></form>`;
    d.onclose = () => res(d.returnValue === "ok" ? (getVal ? getVal() : true) : null); d.returnValue = ""; d.showModal(); });
}
const authTxt = (c) => !c.rug ? '<span class="pill mid">auth unknown</span>' : (c.mintAuthority || c.freezeAuthority) ? '<span class="pill bad">auth ENABLED</span>' : '<span class="pill good">auth revoked</span>';
function coinCard(c) {
  const live = S.settings.live && !S.liveLockDay;
  return `<div class="panel coin" data-mint="${esc(c.mint)}"><div>${c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy">` : ""}<b>${esc(c.symbol || U)}</b> <small>${esc(c.name || "")}</small>
   ${c.worth ? '<span class="pill gold">ENTRY ✓</span>' : ""}${isPick(c.mint) ? '<span class="pill gold">Argus pick</span>' : ""}<br>
   <span class="pill ${c.heat.score >= 65 ? "good" : ""}">Heat ${c.heat.score}</span><span class="pill ${c.risk.score <= 40 ? "good" : c.risk.score >= 70 ? "bad" : "mid"}">Risk ${c.risk.score} ${c.risk.grade}</span>${authTxt(c)}
   <small> ${price(c.priceUsd)} · liq ${usd(c.liq)} · vol1h ${usd(c.volH1)} · 1h <span class="${cls(c.chgH1)}">${pct(c.chgH1)}</span> · age ${c.ageMin === null ? U : ago(c.createdAt)}</small>
   ${c.worth ? "" : `<br><small class="mut">${esc(c.entry.why.slice(0, 3).join(" · "))}</small>`}</div>
   <div class="row" style="flex-direction:column;align-items:stretch"><button class="btn small" data-pbuy="${esc(c.mint)}">Paper buy</button>${live ? `<button class="btn small red" data-lbuy="${esc(c.mint)}">Live buy…</button>` : ""}<a class="btn small ghost" href="${esc(c.dsUrl)}" target="_blank" rel="noopener">Chart</a></div></div>`;
}
function render() {
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  const mb = $("#modeBadge"); const live = S.settings.live && !S.liveLockDay; mb.textContent = live ? "LIVE" : S.liveLockDay ? "PAPER (live locked)" : "PAPER"; mb.classList.toggle("live", live);
  const m = $("#main");
  if (tab === "scanner") {
    const list = [...coins.values()].filter((c) => c.heat).sort((a, b) => (b.worth - a.worth) || b.heat.score - a.heat.score);
    const st = Object.entries(A.apiStatus).map(([k, v]) => `<span class="pill ${v.ok ? "good" : "bad"}">${esc(k)} ${v.ok ? "ok" : "✕ " + esc(v.err)}</span>`).join("");
    m.innerHTML = `<div class="panel"><b>Entry rules:</b> Heat ≥ ${M.strategy.minHeat} · Risk ≤ ${M.strategy.maxRisk} · liquidity ≥ ${usd(M.strategy.minLiqUsd)} · mint + freeze authority revoked. <br><small>${st || "Sources: loading…"}</small></div>` +
      (list.length ? list.map(coinCard).join("") : `<p class="empty">${lastRefresh ? "No coins returned by the data sources right now." : "Scanning DexScreener / GeckoTerminal / RugCheck…"}</p>`);
  } else if (tab === "signals") {
    if (feed === null) { m.innerHTML = '<p class="empty">Loading Argus × Hades feed…</p>'; return; }
    if (!feed) { m.innerHTML = `<div class="panel"><h2>Argus × Hades</h2><p><b>Not reachable.</b> ${C.feedUrls.map((u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`).join(" / ")} (${esc(A.apiStatus["Argus × Hades feed"]?.err || U)}). Nothing is shown rather than made up.</p></div>`; return; }
    const picks = feed.argus?.picks || [], tr = (feed.trades || []).filter((t) => t.action !== "DEPOSIT");
    m.innerHTML = `<div class="panel"><h2>Argus picks</h2><small>Feed updated ${esc(feed.updated_aest || U)} · <a href="${esc(feed._url)}" target="_blank" rel="noopener">source</a> · research only; a pick is only traded if it also passes the entry rules.</small></div>` +
      (picks.length ? picks.map((p) => { const c = coins.get(p.ca); return `<div class="panel"><b>${esc(p.symbol || U)}</b> <span class="pill">${esc(p.rank || U)}</span> <span class="pill">${p.score10 ?? U}/10</span> <span class="pill mid">risk ${esc(p.risk || U)}</span> <small>${esc(p.time_aest || "")}</small>
        <p><small>${esc(p.reason || "")}</small><br><small class="mut">${esc(p.levels || "")}</small></p>
        ${c?.heat ? `<span class="pill">Heat ${c.heat.score}</span><span class="pill">Risk ${c.risk.score}</span>${c.worth ? '<span class="pill gold">ENTRY ✓</span>' : `<small class="mut"> fails: ${esc(c.entry.why.join(" · "))}</small>`}` : '<small class="mut">Live data loading on next scan…</small>'}
        ${p.ca ? ` <button class="btn small" data-pbuy="${esc(p.ca)}">Paper buy</button>` : ""}</div>`; }).join("") : '<p class="empty">No Argus picks in the feed.</p>') +
      `<div class="panel"><h2>Hades trades</h2><small>${tr.length} rows</small><table><tr><th>Time</th><th>Action</th><th>Token</th><th>SOL</th><th>Reason</th></tr>${tr.slice(-30).reverse().map((t) => `<tr><td>${esc(t.time_aest || t.time || "")}</td><td>${esc(t.action || "")}</td><td>${esc(t.symbol || t.token || "")}</td><td>${esc(t.sol ?? t.amount_sol ?? "")}</td><td><small>${esc(t.reason || t.notes || "")}</small></td></tr>`).join("")}</table></div>`;
  } else if (tab === "live") {
    m.innerHTML = `<div class="panel"><h2>Wallet</h2>${walletHelp()}</div>
     <div class="panel"><h2>Wallet transactions (live)</h2><div id="txPanel">${txRows()}</div><small class="mut">Classified from this wallet's token/SOL balance changes: buy = token in for SOL/USDC/USDT, sell = the reverse, swap = token for token, transfer = one asset in or out. Anything else reads "unknown". Newest first, max 100.</small></div>
     <div class="panel"><h2>Market trades (watched coins)</h2><div id="mktPanel">${mktRows()}</div></div>`;
  } else if (tab === "portfolio") {
    const eq = equity(), pl = eq - S.start, closed = S.log.filter((l) => l.side === "SELL"), wins = closed.filter((l) => l.pnl > 0).length;
    m.innerHTML = `<div class="panel kv"><div><small>Paper equity</small><div class="big">${usd(eq)}</div></div><div><small>Cash</small><div class="big">${usd(S.cash)}</div></div><div><small>P&amp;L</small><div class="big ${cls(pl)}">${pl >= 0 ? "+" : ""}${usd(pl)} (${pct(pl / S.start * 100)})</div></div><div><small>Win rate</small><div class="big">${closed.length ? Math.round(wins / closed.length * 100) + "%" : "–"}</div><small>${closed.length} closed</small></div></div>
     <div class="panel row"><label><input type="checkbox" id="autoPaper" ${S.settings.autoPaper ? "checked" : ""}> Auto-paper (follow STRATEGY.md rules, size ${S.settings.sizePct}% of equity, max ${S.settings.maxOpen} open)</label><button class="btn small ghost" id="csv">⬇ Export CSV</button><button class="btn small ghost" id="reset">Reset paper ($${M.paper.startUsd})</button></div>
     <div class="panel"><h2>Open paper positions</h2>${S.positions.length ? `<table><tr><th>Coin</th><th>Entry</th><th>Now</th><th>Value</th><th>P&amp;L</th><th>SL / TP</th><th></th></tr>${S.positions.map((p) => { const px = priceOf(p.mint), ch = px ? (px / p.entry - 1) * 100 : null; return `<tr><td><b>${esc(p.symbol)}</b><br><small>${esc(p.src)} · ${ago(p.at)}</small></td><td>${price(p.entry)}</td><td>${price(px)}</td><td>${usd(px ? p.qty * px : null)}</td><td class="${cls(ch)}">${pct(ch)}</td><td>-${p.sl}% / +${p.tp}%</td><td><button class="btn small" data-psell="${p.id}">Sell</button></td></tr>`; }).join("")}</table>` : '<p class="mut">None. Use “Paper buy” in the Scanner.</p>'}</div>
     ${S.livePositions.length ? `<div class="panel"><h2>Live positions (wallet)</h2><table><tr><th>Coin</th><th>SOL in</th><th>Entry</th><th>Now</th><th></th></tr>${S.livePositions.map((p) => `<tr><td>${esc(p.symbol)}</td><td>${p.sol}</td><td>${price(p.entry)}</td><td>${price(priceOf(p.mint))} <span class="${cls(priceOf(p.mint) / p.entry - 1)}">${p.entry && priceOf(p.mint) ? pct((priceOf(p.mint) / p.entry - 1) * 100) : ""}</span></td><td><button class="btn small red" data-lsell="${p.id}">Sell (sign)…</button></td></tr>`).join("")}</table><small>Live SL/TP only alerts; every sell needs your Phantom signature.</small></div>` : ""}
     <div class="panel"><h2>Trade log</h2>${S.log.length + S.liveLog.length ? `<table><tr><th>Time (AEST)</th><th>Side</th><th>Coin</th><th>Price</th><th>USD</th><th>P&amp;L</th><th>Reason</th></tr>${[...S.log.map((l) => ({ ...l, mode: "paper" })), ...S.liveLog.map((l) => ({ ...l, mode: "live" }))].sort((a, b) => b.t - a.t).slice(0, 200).map((l) => `<tr><td><small>${bneTime(l.t)}</small></td><td>${esc(l.side)}</td><td>${esc(l.symbol)}</td><td>${price(+l.price)}</td><td>${l.usd === "" ? U : usd(+l.usd)}</td><td class="${cls(l.pnl)}">${l.pnl === null || l.pnl === undefined ? "" : usd(l.pnl)}</td><td><small>${esc(l.reason || l.note || "")}${l.sig ? ` <a href="https://solscan.io/tx/${esc(l.sig)}" target="_blank" rel="noopener">tx</a>` : ""}</small></td></tr>`).join("")}</table>` : '<p class="mut">No trades yet.</p>'}</div>`;
  } else if (tab === "settings") {
    const st = S.settings, locked = liveLocked(), cap = capSol(), lim = dailyLimitSol();
    m.innerHTML = `<div class="panel"><h2>Strategy (defaults to review)</h2><div class="row"><label>Stop-loss −% <input id="s-sl" type="number" min="1" max="95" value="${st.sl}"></label><label>Take-profit +% <input id="s-tp" type="number" min="1" max="1000" value="${st.tp}"></label><label>Paper size % <input id="s-size" type="number" min="1" max="100" value="${st.sizePct}"></label><label>Max open <input id="s-max" type="number" min="1" max="20" value="${st.maxOpen}"></label></div><small>Defaults: SL −${M.strategy.stopLossPct}%, TP +${M.strategy.takeProfitPct}%, ${M.paper.sizePct}% per paper trade. See STRATEGY.md.</small></div>
     <div class="panel"><h2>Live trading</h2>
      <label><input type="checkbox" id="s-live" ${st.live && !locked ? "checked" : ""} ${locked ? "disabled" : ""}> <b>Live trading</b> (OFF by default)</label> ${locked ? `<span class="pill bad">Locked until tomorrow (Brisbane) — daily loss limit hit ${esc(S.liveLockDay)}</span>` : ""}
      <p><b>Not financial advice.</b> Midas never signs: each swap is built with Jupiter and you sign it in Phantom. No seed phrase or private key is ever asked for or stored.</p>
      <div class="row"><label>Per-trade cap % of wallet SOL <input id="s-cap" type="number" min="0.1" max="100" step="0.1" value="${st.capPct}"></label><label>Daily loss limit % (10–15) <input id="s-dl" type="number" min="${M.live.dailyLossMin}" max="${M.live.dailyLossMax}" step="0.5" value="${st.dailyLossPct}"></label><label>Slippage bps <input id="s-slip" type="number" min="10" max="2000" value="${st.slippageBps}"></label></div>
      ${walletHelp()}
      <p>Cap/trade: ${cap === null ? U : cap.toFixed(4) + " SOL"} · today's loss: ${dailyLossSol().toFixed(4)} / ${lim === null ? U : lim.toFixed(4)} SOL</p>
      </div>
     <div class="panel"><h2>Connection</h2><label>Phantom Portal App ID (optional; only for Google/Apple login) <input id="s-app" style="width:260px" value="${esc(st.appId)}" placeholder="from phantom.com/portal"></label><br><label>Solana RPC (read-only) <input id="s-rpc" style="width:300px" value="${esc(st.rpc)}"></label></div>`;
  }
}
document.addEventListener("click", async (e) => {
  const t = e.target.closest("button"); if (!t) return;
  if (t.dataset.tab) { tab = t.dataset.tab; if (tab === "signals" && feed === null) { render(); feed = (await A.argusFeed()) || false; } render(); return; }
  if (t.id === "refresh") return refresh();
  if (t.dataset.pbuy) { const c = coins.get(t.dataset.pbuy); if (!c?.priceUsd) return toast("No live price yet; wait for the next scan.");
    const def = (equity() * S.settings.sizePct / 100).toFixed(2);
    const amt = await ask(`<h2>Paper buy ${esc(c.symbol || U)}</h2><p>Live price ${price(c.priceUsd)}. ${c.worth ? "Passes entry rules." : "⚠ Fails entry rules: " + esc(c.entry.why.join("; "))}</p><label>USD <input id="q-amt" type="number" min="1" step="1" value="${def}"></label><p class="mut">SL −${S.settings.sl}% · TP +${S.settings.tp}% (auto-close while the app is open)</p>`, "Paper buy", () => +$("#q-amt").value);
    if (amt) paperBuy(c.mint, amt); return; }
  if (t.dataset.psell) return paperSell(t.dataset.psell);
  if (t.dataset.lbuy) return liveBuy(t.dataset.lbuy);
  if (t.dataset.lsell) return liveSell(t.dataset.lsell);
  if (t.id === "csv") return csv();
  if (t.id === "reset") { if (await ask("<p>Reset the paper portfolio to $1,000 and clear the paper log?</p>", "Reset")) { Object.assign(S, { cash: M.paper.startUsd, start: M.paper.startUsd, positions: [], log: [], entered: {} }); save(); render(); } return; }
  if (t.id === "connect") { try { if (!W.wallet.address) { setStatus("Waiting for Phantom…"); await W.connect(S.settings.appId.trim()); } await refreshWallet(); } catch (err) { toast("Phantom: " + err.message); } render(); return; }
  if (t.id === "disconnect") { await W.disconnect(); walletSol = null; S.settings.live = false; save(); render(); }
  if (t.id === "openPhantom") return; // plain link (deeplink)
});
document.addEventListener("change", async (e) => {
  const t = e.target, st = S.settings, num = (v, lo, hi, d) => { v = +v; return isNaN(v) ? d : Math.min(hi, Math.max(lo, v)); };
  if (t.id === "autoPaper") { st.autoPaper = t.checked; save(); if (t.checked) autoPaper(); render(); }
  if (t.id === "s-sl") st.sl = num(t.value, 1, 95, M.strategy.stopLossPct);
  if (t.id === "s-tp") st.tp = num(t.value, 1, 1000, M.strategy.takeProfitPct);
  if (t.id === "s-size") st.sizePct = num(t.value, 1, 100, M.paper.sizePct);
  if (t.id === "s-max") st.maxOpen = num(t.value, 1, 20, M.paper.maxOpen);
  if (t.id === "s-cap") st.capPct = num(t.value, 0.1, 100, M.live.capPct);
  if (t.id === "s-dl") st.dailyLossPct = num(t.value, M.live.dailyLossMin, M.live.dailyLossMax, M.live.dailyLossPct);
  if (t.id === "s-slip") st.slippageBps = num(t.value, 10, 2000, M.live.slippageBps);
  if (t.id === "s-app") st.appId = t.value.trim();
  if (t.id === "s-rpc") st.rpc = t.value.trim() || M.rpcUrl;
  if (t.id === "s-live") {
    if (t.checked) {
      t.checked = false;
      if (liveLocked()) return toast("Live mode is locked until tomorrow (Brisbane).");
      const ok = await ask(`<h2>Turn ON live trading?</h2><p>Live mode lets Midas <b>build real Jupiter swaps with real SOL</b>. Each one still opens Phantom and only happens if you sign it there.</p><ul><li>Per-trade cap: ${st.capPct}% of wallet SOL</li><li>Daily loss limit: ${st.dailyLossPct}% → auto-switch to paper, locked until tomorrow (Brisbane)</li><li>Memecoins can go to zero. <b>Not financial advice.</b></li></ul><label><input type="checkbox" id="ack"> I understand and accept the risk</label>`, "Enable live trading", () => $("#ack").checked);
      if (ok === true) { st.live = true; toast("Live trading ON. Connect Phantom to trade."); } else if (ok === false) toast("Tick the box to confirm. Live trading stays OFF.");
    } else st.live = false;
  }
  save(); render();
});
// ---------- boot ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW", e));
render(); rollDay(); renderBadge();
// Wallet: silent detection on load (injected provider onlyIfTrusted, then SDK autoConnect if an App ID is set) + events.
let lastAddr = null;
W.onWalletChange(() => { if (W.wallet.address !== lastAddr) { lastAddr = W.wallet.address; walletSol = null; L.watchWallet(W.wallet.address, S.settings.rpc); if (W.wallet.address) refreshWallet(true); } renderBadge(); render(); });
W.detect(S.settings.appId.trim()).catch((e) => console.warn("wallet detect", e)).finally(() => { renderBadge(); if (tab === "live" || tab === "settings") render(); });
setInterval(() => !document.hidden && W.wallet.address && refreshWallet(true), 30e3);
const livePaint = () => { if (tab !== "live") return; const a = $("#txPanel"), b = $("#mktPanel"); if (a) a.innerHTML = txRows(); if (b) b.innerHTML = mktRows(); };
L.txFeed.onUpdate = livePaint; L.mkt.onUpdate = livePaint;
L.startMarket(() => [...coins.values()].filter((c) => c.heat && c.pair).sort((a, b) => b.heat.score - a.heat.score));
A.argusFeed().then((f) => { feed = f || false; if (tab === "signals") render(); refresh(); });
setInterval(() => !document.hidden && refresh(), C.refreshSec * 1000);
setInterval(() => !document.hidden && tickPrices(), M.priceTickSec * 1000);
setInterval(() => { if (S.settings.live) enforceDaily(); rollDay(); }, 60e3);
window.__midas = { S, coins, paperBuy, paperSell, W, L, watch: (a) => L.watchWallet(a, S.settings.rpc) }; // watch(addr): read-only test hook for the tx panel
