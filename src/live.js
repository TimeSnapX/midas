// Live feeds: (1) the connected wallet's own transactions from Solana RPC, (2) recent trades on the scanner's top coins (GeckoTerminal).
// Nothing is invented: a transaction we can't classify from its balance changes is shown as "unknown".
import { MIDAS as M } from "./config.js";
import * as A from "./api.js";
import { rpc } from "./wallet.js";

const QUOTES = { [M.SOL]: "SOL", EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC", Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT" };
const symCache = new Map(Object.entries(QUOTES));
export async function resolveSymbols(mints) {
  const need = [...new Set(mints)].filter((m) => m && !symCache.has(m));
  for (let i = 0; i < need.length; i += 30) {
    try { const j = await (await fetch("https://api.dexscreener.com/tokens/v1/solana/" + need.slice(i, i + 30).join(","))).json();
      for (const p of Array.isArray(j) ? j : []) for (const t of [p.baseToken, p.quoteToken]) if (t?.address && t.symbol && !symCache.has(t.address)) symCache.set(t.address, t.symbol); } catch {}
    for (const m of need.slice(i, i + 30)) if (!symCache.has(m)) symCache.set(m, null); // not on DexScreener: shown as short mint
  }
}
export const sym = (m) => symCache.get(m) || null;

// ---------- 1) wallet transactions ----------
export const txFeed = { addr: null, list: [], method: "idle", err: null, ws: null, wsState: "off", lastPoll: 0, interval: 8000, onUpdate: () => {} };
const seen = new Set(); let timer = null, busy = false, gen = 0;

export function classify(tx, addr) {
  const m = tx?.meta; if (!m || !tx.transaction) return { kind: "unknown", legs: [] };
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const i = keys.indexOf(addr);
  let lamports = i >= 0 ? (m.postBalances[i] - m.preBalances[i]) : 0;
  if (i === 0) lamports += m.fee || 0; // fee is not a trade leg
  const d = new Map(); // mint -> delta (UI units)
  const add = (b, sign) => { if (b.owner !== addr) return; d.set(b.mint, (d.get(b.mint) || 0) + sign * (+b.uiTokenAmount.uiAmountString || 0)); };
  (m.preTokenBalances || []).forEach((b) => add(b, -1)); (m.postTokenBalances || []).forEach((b) => add(b, +1));
  let sol = lamports / 1e9 + (d.get(M.SOL) || 0); d.delete(M.SOL);
  const legs = [...d].filter(([, v]) => Math.abs(v) > 1e-12).map(([mint, v]) => ({ mint, delta: v }));
  if (Math.abs(sol) > 0.0000001) legs.push({ mint: M.SOL, delta: sol });
  const RENT = 0.0025; // ATA rent can move this much SOL without being a trade leg
  const solLeg = Math.abs(sol) > RENT;
  const tokens = legs.filter((l) => l.mint !== M.SOL), quoteIn = [...tokens.filter((l) => QUOTES[l.mint]), ...(solLeg ? [{ mint: M.SOL, delta: sol }] : [])];
  const nonQ = tokens.filter((l) => !QUOTES[l.mint]);
  const up = nonQ.filter((l) => l.delta > 0), down = nonQ.filter((l) => l.delta < 0);
  const qUp = quoteIn.filter((l) => l.delta > 0), qDown = quoteIn.filter((l) => l.delta < 0);
  let kind = "unknown", main = null, quote = null;
  if (m.err) kind = "failed";
  else if (up.length === 1 && !down.length && qDown.length === 1 && !qUp.length) { kind = "buy"; main = up[0]; quote = qDown[0]; }
  else if (down.length === 1 && !up.length && qUp.length === 1 && !qDown.length) { kind = "sell"; main = down[0]; quote = qUp[0]; }
  else if ((up.length === 1 && down.length === 1 && !qUp.length) || (!nonQ.length && qUp.length === 1 && qDown.length === 1)) { kind = "swap"; main = up[0] || qUp[0]; quote = down[0] || qDown[0]; }
  else if (nonQ.length + quoteIn.length === 1) { kind = "transfer"; main = nonQ[0] || quoteIn[0]; }
  else if (!nonQ.length && !quoteIn.length) kind = "unknown"; // no balance change for this wallet (e.g. program call, or fees only)
  return { kind, main, quote, legs, fee: (m.fee || 0) / 1e9 };
}

async function pollOnce(myGen) {
  if (busy || !txFeed.addr) return; busy = true;
  const url = txFeed.rpc;
  try {
    const sigs = await rpc(url, "getSignaturesForAddress", [txFeed.addr, { limit: 25, commitment: "confirmed" }]);
    if (myGen !== gen) return;
    const fresh = sigs.filter((s) => !seen.has(s.signature)).slice(0, txFeed.list.length ? 15 : 12);
    for (const s of fresh) {
      if (myGen !== gen) return;
      let tx = null;
      try { tx = await rpc(url, "getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]); }
      catch (e) { if (/429|rate/i.test(e.message)) throw e; }
      seen.add(s.signature);
      const c = tx ? classify(tx, txFeed.addr) : { kind: "unknown", legs: [] };
      txFeed.list.push({ sig: s.signature, t: (s.blockTime || tx?.blockTime) ? (s.blockTime || tx.blockTime) * 1000 : null, err: !!s.err, ...c });
      await new Promise((r) => setTimeout(r, 200)); // gentle on the public RPC
    }
    txFeed.list.sort((a, b) => (b.t || 0) - (a.t || 0)); txFeed.list = txFeed.list.slice(0, 100);
    await resolveSymbols(txFeed.list.flatMap((x) => x.legs.map((l) => l.mint)));
    txFeed.err = null; txFeed.interval = 8000; txFeed.lastPoll = Date.now();
  } catch (e) {
    txFeed.err = e.message; txFeed.interval = Math.min(60000, txFeed.interval * 2); // exponential backoff
  } finally { busy = false; }
  if (myGen === gen) txFeed.onUpdate();
}
function schedule(myGen, ms) { clearTimeout(timer); timer = setTimeout(async () => { await pollOnce(myGen); if (myGen === gen) schedule(myGen, txFeed.wsState === "open" ? Math.max(30000, txFeed.interval) : txFeed.interval); }, ms); }

function openWs(myGen) {
  const wsUrl = txFeed.rpc.replace(/^http/, "ws");
  let ws; try { ws = new WebSocket(wsUrl); } catch { txFeed.wsState = "unavailable"; return; }
  txFeed.ws = ws; txFeed.wsState = "connecting";
  let ping = null, kick = null;
  ws.onopen = () => { txFeed.wsState = "open"; ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [txFeed.addr] }, { commitment: "confirmed" }] }));
    ping = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "getHealth" })), 25000); txFeed.onUpdate(); };
  ws.onmessage = (e) => { let j; try { j = JSON.parse(e.data); } catch { return; }
    if (j.method === "logsNotification") { clearTimeout(kick); kick = setTimeout(() => myGen === gen && schedule(myGen, 0), 1500); } // debounce bursts, then fetch details
    if (j.id === 1 && j.error) { txFeed.wsState = "rejected"; ws.close(); } };
  ws.onclose = () => { clearInterval(ping); if (myGen !== gen) return; if (txFeed.wsState !== "rejected") txFeed.wsState = "closed"; txFeed.onUpdate();
    setTimeout(() => myGen === gen && txFeed.wsState !== "rejected" && openWs(myGen), 15000); schedule(myGen, txFeed.interval); };
  ws.onerror = () => {}; // onclose follows
}
export function watchWallet(addr, rpcUrl) {
  gen++; clearTimeout(timer); try { txFeed.ws?.close(); } catch {}
  txFeed.ws = null; txFeed.wsState = "off"; txFeed.list = []; seen.clear(); txFeed.err = null; txFeed.addr = addr || null; txFeed.rpc = rpcUrl || M.rpcUrl;
  if (!addr) { txFeed.method = "idle"; txFeed.onUpdate(); return; }
  txFeed.method = "websocket logsSubscribe + getSignaturesForAddress/getTransaction"; openWs(gen); schedule(gen, 0);
}

// ---------- 2) market trades on watched coins (GeckoTerminal, rotating within the shared limiter) ----------
export const mkt = { list: [], pools: [], i: 0, err: null, lastAt: 0, onUpdate: () => {}, getWatched: () => [] };
const mseen = new Set(); let mtimer = null;
async function mktTick() {
  if (document.hidden) return;
  const watched = mkt.getWatched().filter((c) => c.pair).slice(0, 5); mkt.pools = watched;
  if (!watched.length) return;
  const c = watched[mkt.i++ % watched.length];
  const tr = await A.gtTrades(c.pair, c.mint);
  if (!tr) { mkt.err = A.apiStatus["GeckoTerminal trades"]?.err || "unknown error"; mkt.onUpdate(); return; }
  mkt.err = null; mkt.lastAt = Date.now();
  for (const x of tr) if (!mseen.has(x.id)) { mseen.add(x.id); mkt.list.push({ ...x, mint: c.mint, symbol: c.symbol || null }); }
  mkt.list.sort((a, b) => (b.t || 0) - (a.t || 0)); mkt.list = mkt.list.slice(0, 150);
  if (mseen.size > 5000) mseen.clear();
  mkt.onUpdate();
}
export function startMarket(getWatched, everyMs = 10000) { mkt.getWatched = getWatched; clearInterval(mtimer); mktTick(); mtimer = setInterval(mktTick, everyMs); } // 6 req/min of the shared 15/min budget
