import { CONFIG as C } from "./config.js";
const cl = (x) => Math.max(0, Math.min(1, x));
const lin = (x, lo, hi) => cl((x - lo) / (hi - lo));
const logl = (x, lo, hi) => cl((Math.log10(Math.max(x, 1)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)));
const num = (v) => (v === null || v === undefined || v === "" || isNaN(+v) ? null : +v);

// Heat 0-100. Missing data scores 0 for that part (never invents upside).
export function heatScore(c) {
  const H = C.heat, W = C.heatWeights, parts = {};
  const v1 = num(c.volH1), v5 = num(c.volM5);
  let vol = 0; if (v1 !== null) { vol += logl(v1, H.volH1Lo, H.volH1Hi) * 15; if (v5 !== null && v1 > 0) vol += lin((v5 * 12) / v1, H.accelLo, H.accelHi) * 10; }
  parts.volume = vol;
  let buys = 0; const b = num(c.buysH1), s = num(c.sellsH1);
  if (b !== null && s !== null && b + s > 0) buys += lin(b / (b + s), H.buyRatioLo, H.buyRatioHi) * 15;
  if (num(c.buysM5) !== null) buys += cl(c.buysM5 / H.m5BuysHi) * 10;
  parts.buys = buys;
  parts.liquidity = num(c.liq) !== null ? logl(c.liq, H.liqLo, H.liqHi) * W.liquidity : 0;
  let age = 0; if (num(c.ageMin) !== null) { const m = c.ageMin, h = m / 60;
    age = m < H.ageRampMin ? m / H.ageRampMin : h <= H.ageSweetMaxH ? 1 : h <= H.ageFadeMaxH ? 1 - (2 / 3) * ((h - H.ageSweetMaxH) / (H.ageFadeMaxH - H.ageSweetMaxH)) : 0; }
  parts.age = age * W.age;
  parts.holders = num(c.holderGrowthPerMin) !== null ? cl(c.holderGrowthPerMin / H.holderGrowthPerMinHi) * W.holders : 0;
  const total = Math.round(Object.values(parts).reduce((a, x) => a + x, 0));
  return { score: Math.min(100, total), parts };
}

// Risk 0-100, higher = worse. Returns flags (the reasons) too.
export function riskScore(c) {
  const P = C.riskPoints, R = C.risk, U = C.unknownFactor; let pts = 0; const flags = []; let hardFail = false;
  const add = (p, f, sev = "warn") => { pts += p; if (f) flags.push({ f, p: Math.round(p * 10) / 10, sev }); };
  if (c.rug) {
    if (c.mintAuthority) { add(P.mint, "Mint authority enabled", "bad"); hardFail = true; }
    if (c.freezeAuthority) { add(P.freeze, "Freeze authority enabled", "bad"); hardFail = true; }
  } else { add(C.authorityUnknownPoints, "Mint authority unknown", "unk"); add(C.authorityUnknownPoints, "Freeze authority unknown", "unk"); }
  if (num(c.lpLockedPct) !== null) { if (c.lpLockedPct < R.lpSafePct) add(P.lp * (1 - c.lpLockedPct / 100), `LP only ${c.lpLockedPct.toFixed(0)}% locked/burned`, c.lpLockedPct < 25 ? "bad" : "warn"); }
  else add(P.lp * U, "LP lock unknown", "unk");
  if (num(c.top10Pct) !== null) { const p = lin(c.top10Pct, R.top10Lo, R.top10Hi) * P.top10; if (p > 0) add(p, `Top-10 holders own ${c.top10Pct.toFixed(1)}%`, c.top10Pct >= R.top10Hi ? "bad" : "warn"); }
  else add(P.top10 * U, "Top-10 holder share unknown", "unk");
  if (num(c.boosts) > 0) add(c.boosts >= R.boostBig ? P.boosts : P.boosts / 2, `Paid DexScreener boosts (${c.boosts})`);
  const b = num(c.buysH1), s = num(c.sellsH1);
  if (b !== null && s !== null && b + s >= R.washTxMin && Math.abs(b - s) / (b + s) < R.washImbalanceMax) add(8, "Bot-like trading: buys ≈ sells on high tx count");
  if (num(c.volH1) !== null && num(c.liq) > 0 && c.volH1 / c.liq > R.volLiqMax) add(7, `Bot-like trading: 1h volume ${(c.volH1 / c.liq).toFixed(0)}x liquidity`);
  if (num(c.liq) !== null && c.liq < R.lowLiqUsd) add(P.lowLiq, "Liquidity under $10k");
  if (num(c.liq) === null) add(P.lowLiq * U, "Liquidity unknown", "unk");
  let score = Math.min(100, Math.round(pts)); if (hardFail) score = Math.max(score, 70);
  const grade = C.grades.find((g) => score <= g.max).g;
  return { score, grade, flags, hardFail };
}

export function isWorth(c, w = C.worth) {
  return !!(c.heat && c.risk && c.rug && !c.risk.hardFail && c.heat.score >= w.minHeat && c.risk.score <= w.maxRisk && num(c.liq) >= w.minLiqUsd);
}
