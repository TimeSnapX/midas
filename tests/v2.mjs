// node tests/v2.mjs [url] — headless Chrome checks for wallet detection, Open-in-Phantom, mock provider badge, tx panel, market trades.
import { createRequire } from "node:module";
const { chromium } = createRequire("/workspace/tools/package.json")("playwright-core");
const URL_ = process.argv[2] || "https://timesnapx.github.io/midas/", OUT = process.argv[3] || "/workspace/out";
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const R = {};
const mkPage = async (ua) => { const ctx = await b.newContext({ viewport: { width: 412, height: 915 }, userAgent: ua }); const p = await ctx.newPage(); const errs = [];
  p.on("pageerror", (e) => errs.push("pageerror " + e.message)); p.on("console", (m) => m.type() === "error" && errs.push("console " + m.text())); return { ctx, p, errs }; };
const PIXEL = "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
// A) Chrome, no provider
{ const { ctx, p, errs } = await mkPage(PIXEL);
  await p.goto(URL_, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(2500);
  await p.click('nav [data-tab="live"]'); await p.waitForSelector("#openPhantom");
  R.noProvider = await p.evaluate(() => ({ badge: document.querySelector("#walletBadge").textContent, href: document.querySelector("#openPhantom").href, why: document.querySelector(".wbox p")?.innerText.slice(0, 120) }));
  // market trades
  await p.waitForSelector("#mktTable tr:nth-child(2)", { timeout: 120000 }).catch(() => {});
  R.market = await p.evaluate(() => ({ rows: document.querySelectorAll("#mktTable tr").length - 1, first: document.querySelector("#mktTable tr:nth-child(2)")?.innerText, trader: window.__midas.L.mkt.list.map((x) => x.trader).filter(Boolean) }));
  await p.screenshot({ path: OUT + "/midas-v2-no-provider.png", fullPage: true });
  // tx panel with a public busy address picked live from the market feed (most frequent trader)
  const cnt = {}; for (const t of R.market.trader) cnt[t] = (cnt[t] || 0) + 1; const addr = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0]?.[0];
  delete R.market.trader; R.testAddr = addr;
  await p.evaluate((a) => window.__midas.watch(a), addr);
  await p.waitForSelector("#txTable tr:nth-child(2)", { timeout: 90000 }).catch(() => {});
  await p.waitForTimeout(8000);
  R.txPanel = await p.evaluate(() => { const f = window.__midas.L.txFeed; return { ws: f.wsState, err: f.err, count: f.list.length, kinds: f.list.reduce((o, x) => (o[x.kind] = (o[x.kind] || 0) + 1, o), {}), sample: [...document.querySelectorAll("#txTable tr")].slice(1, 4).map((r) => r.innerText.replace(/\s+/g, " ")) }; });
  await p.screenshot({ path: OUT + "/midas-v2-tx-panel.png", fullPage: true });
  R.errorsA = errs; await ctx.close(); }
// B) mock injected provider (Phantom in-app browser)
{ const { ctx, p, errs } = await mkPage(PIXEL + " Phantom/mock");
  await ctx.addInitScript(() => { const pk = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"; const h = {};
    const prov = { isPhantom: true, isConnected: false, publicKey: null, on: (e, f) => ((h[e] = h[e] || []).push(f)),
      connect: async (o) => { prov.isConnected = true; prov.publicKey = { toBase58: () => pk, toString: () => pk }; setTimeout(() => (h.connect || []).forEach((f) => f(prov.publicKey))); return { publicKey: prov.publicKey }; }, disconnect: async () => {} };
    window.phantom = { solana: prov }; window.solana = prov; });
  await p.goto(URL_, { waitUntil: "domcontentloaded" });
  await p.waitForFunction(() => /SOL/.test(document.querySelector("#walletBadge").textContent), null, { timeout: 30000 }).catch(() => {});
  R.mock = await p.evaluate(() => ({ badge: document.querySelector("#walletBadge").textContent, connected: document.querySelector("#walletBadge").dataset.connected }));
  await p.screenshot({ path: OUT + "/midas-v2-mock-header.png" });
  await p.click('nav [data-tab="settings"]'); await p.waitForTimeout(500);
  R.mockSettings = await p.evaluate(() => document.querySelector(".wbox")?.innerText.replace(/\s+/g, " ").slice(0, 200));
  await p.screenshot({ path: OUT + "/midas-v2-mock-settings.png", fullPage: true });
  await p.click('nav [data-tab="live"]'); await p.waitForTimeout(6000);
  await p.screenshot({ path: OUT + "/midas-v2-mock-live.png", fullPage: true });
  R.errorsB = errs; await ctx.close(); }
console.log(JSON.stringify(R, null, 2)); await b.close();
