/* PumpRadar auto-trader (Phase 4 · started by Basha 2026-10-28)
 *
 * Buys pump.fun tokens on Telegram BUY signals that pass the Phase 4 gate, and manages exits.
 * HARD LIMITS (in code, cannot be changed from Telegram):
 *   $5 max per buy · max 4 open positions · sell 50% at 2x · sell all at -35% · max hold 90 min
 *   hard stop when wallet value <= $10 (all trading stops until /resume) · daily loss limit $10
 *   no new entries 01:00–07:00 Amman · max 12 buys per day
 * SAFETY:
 *   - DRY RUN by default. Real orders only when TRADER_LIVE=1.
 *   - The private key comes only from the TRADER_KEY secret (base58). It is never logged, sent or stored.
 *   - Transactions are built by PumpPortal's local-trade API, then signed HERE and sent through Helius.
 *   - /stop in Telegram halts all trading instantly (state survives restarts).
 */
const fs = require("fs"), path = require("path");
const { Keypair, VersionedTransaction, Connection, PublicKey, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const bs58 = require("bs58");

const LIMITS = Object.freeze({ maxUsd: 5, maxOpen: 4, tpX: 2, tpFrac: 0.5, slX: 0.65, maxHoldMin: 90,
  hardStopUsd: 10, dailyLossUsd: 10, maxBuysPerDay: 12, curfewFrom: 1, curfewTo: 7,
  slippagePct: 15, priorityFeeSol: 0.0003, minSolReserve: 0.01 });

function makeTrader({ dataDir, heliusKey, tz, notify }) {
  const LIVE = process.env.TRADER_LIVE === "1";
  const SECRET = (process.env.TRADER_KEY || "").trim();
  const FILE = path.join(dataDir, "trader.json");
  let kp = null;
  let keyError = SECRET ? "" : "TRADER_KEY is empty or missing";
  if (SECRET) {
    try {
      // Accept both formats: base58 string (Phantom) or a JSON number array like [12,34,...] (Solflare / CLI)
      const raw = SECRET.replace(/^["']|["']$/g, "").trim();
      const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : (bs58.decode ? bs58.decode(raw) : bs58.default.decode(raw));
      if (bytes.length !== 64) throw new Error(`key has ${bytes.length} bytes, expected 64`);
      kp = Keypair.fromSecretKey(bytes);
    } catch (e) { keyError = "TRADER_KEY could not be read (" + e.message.slice(0, 60) + ")"; console.error("trader:", keyError); }
  }
  const enabled = !!kp && process.env.AUTO_TRADE === "1";
  const conn = new Connection("https://mainnet.helius-rpc.com/?api-key=" + encodeURIComponent(heliusKey || ""), "confirmed");

  let st = { halted: false, haltReason: "", positions: {}, day: "", buysToday: 0, realizedToday: 0, realizedAll: 0, log: [] };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch {}
  const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(st)); } catch {} };
  const amman = () => { const d = new Date(); return { h: +new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(d) % 24, day: d.toLocaleDateString("en-CA", { timeZone: tz }) }; };
  const rollDay = () => { const { day } = amman(); if (st.day !== day) { st.day = day; st.buysToday = 0; st.realizedToday = 0; save(); } };
  const log = (t) => { st.log.unshift({ ts: Date.now(), t }); st.log.length = Math.min(st.log.length, 200); save(); console.log("trader:", t); };

  let solUsd = null, solUsdAt = 0;
  async function solPrice() {
    if (solUsd && Date.now() - solUsdAt < 60000) return solUsd;
    try { const j = await (await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { signal: AbortSignal.timeout(8000) })).json(); if (j?.solana?.usd) { solUsd = j.solana.usd; solUsdAt = Date.now(); } } catch {}
    return solUsd;
  }
  async function solBalance() { return kp ? (await conn.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL : 0; }
  async function tokenBalance(mint) {
    const r = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { mint: new PublicKey(mint) });
    return r.value.reduce((a, x) => a + (+x.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
  }
  // Value of a holding in SOL via a sell quote (Jupiter). null = unknown (then only the bot's SELL signals / max hold exit).
  async function quoteSol(mint, uiAmount) {
    try {
      const info = await conn.getParsedAccountInfo(new PublicKey(mint)); const dec = info.value?.data?.parsed?.info?.decimals ?? 6;
      const amt = BigInt(Math.floor(uiAmount * 10 ** dec));
      if (amt <= 0n) return 0;
      const r = await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${mint}&outputMint=So11111111111111111111111111111111111111112&amount=${amt}&slippageBps=1500`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return null; const j = await r.json(); return +j.outAmount / LAMPORTS_PER_SOL;
    } catch { return null; }
  }

  async function execute(action, mint, amount, denominatedInSol) {
    const body = { publicKey: kp.publicKey.toBase58(), action, mint, amount, denominatedInSol: denominatedInSol ? "true" : "false",
      slippage: LIMITS.slippagePct, priorityFee: LIMITS.priorityFeeSol, pool: "auto" };
    if (!LIVE) return { dry: true, sig: "DRY-RUN" };
    const r = await fetch("https://pumpportal.fun/api/trade-local", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (r.status !== 200) throw new Error("PumpPortal " + r.status + " " + (await r.text()).slice(0, 120));
    const tx = VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer()));
    tx.sign([kp]);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    const conf = await conn.confirmTransaction(sig, "confirmed");
    if (conf.value?.err) throw new Error("tx failed " + JSON.stringify(conf.value.err));
    return { sig };
  }

  async function walletUsd() {
    const px = await solPrice(); if (!px) return null;
    let sol = await solBalance();
    for (const p of Object.values(st.positions)) { const v = p.lastValSol; if (v != null) sol += v; else sol += p.costSol; }
    return sol * px;
  }
  async function checkHardStop() {
    const v = await walletUsd();
    if (v != null && v <= LIMITS.hardStopUsd && !st.halted) { st.halted = true; st.haltReason = `hard stop: wallet $${v.toFixed(2)} <= $${LIMITS.hardStopUsd}`; save(); notify(`🛑 <b>Auto-trader HALTED</b>\n${st.haltReason}\nNo new buys until you review and send /resume.`); }
    if (-st.realizedToday * (solUsd || 0) >= LIMITS.dailyLossUsd && !st.halted) { st.halted = true; st.haltReason = "daily loss limit $" + LIMITS.dailyLossUsd; save(); notify(`🛑 <b>Auto-trader HALTED</b>: daily loss limit reached. Resumes only with /resume.`); }
    return v;
  }

  async function onBuySignal(p) {
    if (!enabled) return;
    rollDay();
    const tag = LIVE ? "" : "🧪 DRY RUN · ";
    const skip = (why) => { log(`skip ${p.sym}: ${why}`); return null; };
    if (st.halted) return skip("halted (" + st.haltReason + ")");
    if (p.gate?.blocks?.length) return skip("gate: " + p.gate.blocks.join("; "));
    const { h } = amman(); if (h >= LIMITS.curfewFrom && h < LIMITS.curfewTo) return skip("curfew 01–07");
    if (Object.keys(st.positions).length >= LIMITS.maxOpen) return skip("max open positions");
    if (st.positions[p.mint]) return skip("already holding");
    if (st.buysToday >= LIMITS.maxBuysPerDay) return skip("max buys today");
    const px = await solPrice(); if (!px) return skip("no SOL price");
    const bal = await solBalance();
    const v = await checkHardStop(); if (st.halted) return skip("hard stop");
    const usd = Math.min(LIMITS.maxUsd, (v || 0) * 0.25);
    const sol = +(usd / px).toFixed(4);
    if (sol <= 0 || bal - sol < LIMITS.minSolReserve) return skip(`not enough SOL (${bal.toFixed(4)})`);
    try {
      const before = LIVE ? await tokenBalance(p.mint).catch(() => 0) : 0;
      const r = await execute("buy", p.mint, sol, true);
      const got = LIVE ? Math.max(0, (await tokenBalance(p.mint)) - before) : 0;
      st.positions[p.mint] = { mint: p.mint, sym: p.sym, costSol: sol, tokens: got, opened: Date.now(), tpHit: false, lastValSol: sol, dry: !LIVE };
      st.buysToday++; save();
      log(`BUY ${p.sym} ${sol} SOL ($${usd.toFixed(2)}) ${r.sig}`);
      notify(`${tag}🤖 <b>BOUGHT ${p.sym}</b> · ${sol} SOL ($${usd.toFixed(2)})\nStop −35% · sell 50% at 2× · max hold ${LIMITS.maxHoldMin} min\n${LIVE ? `<a href="https://solscan.io/tx/${r.sig}">tx</a>` : "No real order (TRADER_LIVE is off)."}\nLog it in Notion → Real Money Desk.`);
    } catch (e) { log(`BUY ${p.sym} failed: ${e.message}`); notify(`⚠️ Auto-buy ${p.sym} failed: ${e.message}`); }
  }

  async function sell(pos, frac, why) {
    const tag = pos.dry ? "🧪 DRY RUN · " : "";
    try {
      let amount = frac >= 1 ? "100%" : Math.floor(pos.tokens * frac * 1e6) / 1e6;
      if (!pos.dry && frac < 1 && !(amount > 0)) amount = "50%";
      const r = pos.dry ? { sig: "DRY-RUN" } : await execute("sell", pos.mint, amount, false);
      const valSol = pos.lastValSol != null ? pos.lastValSol * frac : null, costPart = pos.costSol * frac;
      const pnl = valSol != null ? valSol - costPart : 0;
      st.realizedToday += pnl; st.realizedAll += pnl;
      if (frac >= 1) delete st.positions[pos.mint]; else { pos.tokens *= (1 - frac); pos.costSol -= costPart; pos.tpHit = true; pos.lastValSol = valSol != null ? pos.lastValSol - valSol : null; }
      save(); log(`SELL ${Math.round(frac * 100)}% ${pos.sym} (${why}) pnl ${pnl.toFixed(4)} SOL ${r.sig}`);
      notify(`${tag}🤖 <b>SOLD ${Math.round(frac * 100)}% ${pos.sym}</b> · ${why}\nP&L ≈ ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL ($${(pnl * (solUsd || 0)).toFixed(2)})${pos.dry ? "" : `\n<a href="https://solscan.io/tx/${r.sig}">tx</a>`}`);
      await checkHardStop();
    } catch (e) { log(`SELL ${pos.sym} failed: ${e.message}`); notify(`⚠️ Auto-sell ${pos.sym} failed: ${e.message}. Check Phantom and sell manually if needed.`); }
  }

  async function onSellSignal(p) {
    if (!enabled) return; const pos = st.positions[p.mint]; if (!pos) return;
    const all = /ALL/.test(p.kind); await sell(pos, all ? 1 : 0.5, "bot SELL signal");
  }

  let busy = false;
  async function monitor() {
    if (!enabled || busy) return; busy = true;
    try {
      for (const pos of Object.values(st.positions)) {
        const ageMin = (Date.now() - pos.opened) / 60000;
        if (!pos.dry) { pos.tokens = await tokenBalance(pos.mint).catch(() => pos.tokens); if (pos.tokens <= 0) { delete st.positions[pos.mint]; save(); continue; } }
        const val = pos.dry ? null : await quoteSol(pos.mint, pos.tokens);
        if (val != null) pos.lastValSol = val;
        const x = val != null ? val / pos.costSol : null;
        if (x != null && x <= LIMITS.slX) await sell(pos, 1, `stop −35% (${x.toFixed(2)}×)`);
        else if (x != null && x >= LIMITS.tpX && !pos.tpHit) await sell(pos, LIMITS.tpFrac, `take profit ${x.toFixed(2)}×`);
        else if (ageMin >= LIMITS.maxHoldMin) await sell(pos, 1, `max hold ${LIMITS.maxHoldMin} min`);
      }
      save();
    } catch (e) { console.error("trader monitor:", e.message); } finally { busy = false; }
  }
  setInterval(monitor, 20000);

  async function command(txt) {
    if (txt.startsWith("/stop")) { st.halted = true; st.haltReason = "stopped by Basha (/stop)"; save(); return "🛑 Auto-trader stopped. Open positions keep their exits (stop/TP/max hold). /resume to restart buying."; }
    if (txt.startsWith("/resume")) { st.halted = false; st.haltReason = ""; save(); const v = await checkHardStop(); return st.halted ? "Still halted: " + st.haltReason : `▶️ Auto-trader resumed${v != null ? ` · wallet $${v.toFixed(2)}` : ""}.`; }
    if (txt.startsWith("/sellall")) { for (const p of Object.values(st.positions)) await sell(p, 1, "manual /sellall"); return "Selling everything."; }
    if (txt.startsWith("/trader")) {
      const v = await walletUsd().catch(() => null), pos = Object.values(st.positions);
      return [`🤖 <b>Auto-trader</b> · ${!kp ? keyError : !enabled ? "off (AUTO_TRADE≠1)" : LIVE ? "🔴 LIVE" : "🧪 DRY RUN"}${st.halted ? " · 🛑 HALTED: " + st.haltReason : ""}`,
        kp ? `Wallet ${kp.publicKey.toBase58().slice(0, 4)}…${kp.publicKey.toBase58().slice(-4)} · ${v != null ? "$" + v.toFixed(2) : "—"}` : "",
        `Today: ${st.buysToday}/${LIMITS.maxBuysPerDay} buys · realized ${(st.realizedToday * (solUsd || 0)).toFixed(2)} USD`,
        pos.length ? "Open: " + pos.map(p => `${p.sym} ${p.lastValSol != null ? (p.lastValSol / p.costSol).toFixed(2) + "×" : ""}`).join(", ") : "No open positions.",
        "Commands: /trader /stop /resume /sellall"].filter(Boolean).join("\n");
    }
    return null;
  }
  if (kp) console.log(`trader: ${enabled ? (LIVE ? "LIVE" : "DRY RUN") : "disabled"} · wallet ${kp.publicKey.toBase58().slice(0, 4)}…`);
  return { onBuySignal, onSellSignal, command, enabled: () => enabled, live: LIVE, LIMITS };
}
module.exports = { makeTrader, LIMITS };
