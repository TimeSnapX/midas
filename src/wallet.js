// Live mode plumbing: Phantom Connect (@phantom/browser-sdk, bundled in vendor/phantom-vendor.js and loaded only on demand),
// read-only Solana RPC lookups, and Jupiter quote/swap. Midas NEVER signs anything itself, never sees a seed phrase or
// private key, and never stores keys: every swap is built here and then signed by YOU inside Phantom.
import { MIDAS as M } from "./config.js";
let sdk = null, V = null, inj = null;
export const wallet = { address: null, provider: null, via: null };
const listeners = new Set();
export const onWalletChange = (fn) => listeners.add(fn);
const emit = () => listeners.forEach((fn) => { try { fn(wallet); } catch (e) { console.warn(e); } });
const setAddr = (addr, via) => { wallet.address = addr || null; wallet.provider = addr ? via : null; wallet.via = addr ? via : null; emit(); };

async function vendor() { return V || (V = await import("../vendor/phantom-vendor.js")); }

// The provider Phantom injects: desktop extension, or the Phantom mobile app's in-app browser (window.phantom.solana).
// Chrome on Android has NO provider: the Phantom app's wallet is invisible to other browsers.
export function injectedProvider() {
  const p = window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null);
  return p && typeof p.connect === "function" ? p : null;
}
export const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");
export const phantomBrowseLink = (url = location.href) => `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(location.origin)}`;
const pkStr = (pk) => (pk ? (typeof pk === "string" ? pk : pk.toBase58 ? pk.toBase58() : String(pk)) : null);

function hookInjected(p) {
  if (inj === p) return; inj = p;
  if (typeof p.on !== "function") return;
  p.on("connect", (pk) => setAddr(pkStr(pk) || pkStr(p.publicKey), "injected"));
  p.on("disconnect", () => { if (wallet.via === "injected") setAddr(null); });
  p.on("accountChanged", (pk) => { const a = pkStr(pk); if (a) setAddr(a, "injected"); else p.connect({ onlyIfTrusted: true }).then((r) => setAddr(pkStr(r?.publicKey || p.publicKey), "injected")).catch(() => setAddr(null)); });
}
// Waits briefly for a late-injected provider (the in-app browser can inject after DOMContentLoaded).
async function findInjected(ms = 1500) {
  for (let t = 0; t < ms; t += 100) { const p = injectedProvider(); if (p) return p; await new Promise((r) => setTimeout(r, 100)); }
  return injectedProvider();
}
function hookSdk(s) {
  try { s.on?.("connect", (d) => { const a = (d?.addresses || []).find((x) => /solana/i.test(x.addressType || x.chain || ""))?.address; if (a) setAddr(a, d?.providerType || "phantom-sdk"); });
    s.on?.("disconnect", () => { if (wallet.via !== "injected") setAddr(null); }); } catch (e) { console.warn(e); }
}
async function getSdk(appId) {
  const v = await vendor();
  if (!sdk) {
    // Injected provider (Phantom extension / Phantom mobile in-app browser) works without an App ID.
    // An App ID from phantom.com/portal unlocks the Google/Apple embedded wallet providers too.
    const cfg = { providers: appId ? ["injected", "google", "apple"] : ["injected"], addressTypes: [v.AddressType.solana], autoConnect: false };
    if (appId) { cfg.appId = appId; cfg.authOptions = { redirectUrl: location.origin + location.pathname }; }
    sdk = new v.BrowserSDK(cfg); hookSdk(sdk); // singleton
  }
  return sdk;
}
// Silent check on load: never opens a popup. Returns the address or null.
export async function detect(appId) {
  const p = await findInjected();
  if (p) {
    hookInjected(p);
    if (p.isConnected && p.publicKey) { setAddr(pkStr(p.publicKey), "injected"); return wallet.address; }
    try { const r = await p.connect({ onlyIfTrusted: true }); setAddr(pkStr(r?.publicKey || p.publicKey), "injected"); return wallet.address; } catch { /* not trusted yet: user taps Connect */ }
  }
  if (appId) { // embedded (Google/Apple) session restore
    try { const s = await getSdk(appId); await s.autoConnect?.(); const a = sdkAddress(s); if (a) setAddr(a, "phantom-sdk"); } catch (e) { console.warn("SDK autoConnect", e?.message); }
  }
  return wallet.address;
}
function sdkAddress(s) { try { const a = s.getAddresses?.() || []; return (a.find?.((x) => /solana/i.test(x.addressType || x.chain || "")) || {}).address || null; } catch { return null; } }

export async function connect(appId) {
  const p = await findInjected(800);
  if (p) { hookInjected(p); const r = await p.connect(); setAddr(pkStr(r?.publicKey || p.publicKey), "injected"); return wallet.address; }
  if (!appId) throw new Error("No Phantom wallet in this browser. On a phone, tap 'Open in Phantom' (Chrome can't see the Phantom app's wallet), or add a Phantom Portal App ID in Settings for Google/Apple login.");
  const s = await getSdk(appId);
  const res = await s.connect({ provider: "google" });
  const sol = (res.addresses || []).find((a) => /solana/i.test(a.addressType || a.chain || ""));
  if (!sol) throw new Error("No Solana address returned by Phantom");
  setAddr(sol.address, "google"); return wallet.address;
}
export async function disconnect() { try { if (wallet.via === "injected") await inj?.disconnect(); else await sdk?.disconnect(); } catch {} setAddr(null); }

export async function rpc(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
export async function solBalance(url, addr) { const r = await rpc(url, "getBalance", [addr, { commitment: "confirmed" }]); return r.value / 1e9; }
export async function tokenBalanceRaw(url, addr, mint) {
  const r = await rpc(url, "getTokenAccountsByOwner", [addr, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
  let raw = 0n, dec = 0; for (const a of r.value || []) { const t = a.account.data.parsed.info.tokenAmount; raw += BigInt(t.amount); dec = t.decimals; }
  return { raw, dec };
}
export async function solUsd() {
  try { const j = await (await fetch(`${M.jupiter.price}?ids=${M.SOL}`)).json(); const p = +j?.[M.SOL]?.usdPrice; if (p > 0) return p; } catch {}
  try { const j = await (await fetch("https://api.dexscreener.com/tokens/v1/solana/" + M.SOL)).json(); const p = +(j || []).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]?.priceUsd; if (p > 0) return p; } catch {}
  return null;
}
// Build (never sign) a Jupiter swap. amount is in the input mint's smallest unit, as a string.
export async function buildSwap({ inputMint, outputMint, amount, slippageBps }) {
  const q = await fetch(`${M.jupiter.quote}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`).then((r) => r.json());
  if (!q || q.error || !q.outAmount) throw new Error("Jupiter quote failed: " + (q?.error || "no route"));
  const s = await fetch(M.jupiter.swap, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: wallet.address, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto" }) }).then((r) => r.json());
  if (!s?.swapTransaction) throw new Error("Jupiter swap build failed: " + (s?.error || "unknown"));
  return { quote: q, b64: s.swapTransaction };
}
// Hand the built transaction to Phantom. Phantom shows its own approval screen; the user signs (or rejects) there.
export async function signAndSend(b64) {
  if (!wallet.address) throw new Error("Wallet not connected");
  const v = await vendor();
  const tx = v.VersionedTransaction.deserialize(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  const r = wallet.via === "injected" ? await inj.signAndSendTransaction(tx) : await sdk.solana.signAndSendTransaction(tx);
  return r?.signature || r?.hash || r;
}
