// Live mode plumbing: Phantom Connect (@phantom/browser-sdk, bundled in vendor/phantom-vendor.js and loaded only on demand),
// read-only Solana RPC lookups, and Jupiter quote/swap. Midas NEVER signs anything itself, never sees a seed phrase or
// private key, and never stores keys: every swap is built here and then signed by YOU inside Phantom.
import { MIDAS as M } from "./config.js";
let sdk = null, V = null;
export const wallet = { address: null, provider: null };

async function vendor() { return V || (V = await import("../vendor/phantom-vendor.js")); }

export async function connect(appId) {
  const v = await vendor();
  if (!sdk) {
    // Injected provider (Phantom extension / Phantom mobile in-app browser) works without an App ID.
    // An App ID from phantom.com/portal unlocks the Google/Apple embedded wallet providers too.
    const cfg = { providers: appId ? ["injected", "google", "apple"] : ["injected"], addressTypes: [v.AddressType.solana], autoConnect: false };
    if (appId) { cfg.appId = appId; cfg.authOptions = { redirectUrl: location.origin + location.pathname }; }
    sdk = new v.BrowserSDK(cfg); // singleton
  }
  let provider = "injected";
  if (!appId) { const has = await v.waitForPhantomExtension(3000).catch(() => false); if (!has) throw new Error("Phantom extension not found. Install Phantom, or open Midas inside the Phantom app browser, or add a Phantom Portal App ID in Settings for Google/Apple login."); }
  else if (!(await v.waitForPhantomExtension(1500).catch(() => false))) provider = "google";
  const res = await sdk.connect({ provider });
  const sol = (res.addresses || []).find((a) => /solana/i.test(a.addressType || a.chain || ""));
  if (!sol) throw new Error("No Solana address returned by Phantom");
  wallet.address = sol.address; wallet.provider = provider; return wallet.address;
}
export async function disconnect() { try { await sdk?.disconnect(); } catch {} wallet.address = null; }

async function rpc(url, method, params) {
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
  if (!sdk || !wallet.address) throw new Error("Wallet not connected");
  const v = await vendor();
  const tx = v.VersionedTransaction.deserialize(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  const r = await sdk.solana.signAndSendTransaction(tx);
  return r?.signature || r?.hash || r;
}
