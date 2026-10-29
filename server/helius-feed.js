/* Read-only trade feed for PumpRadar from Helius (Solana websocket logsSubscribe on the Pump program).
   PumpPortal's trade stream now needs a paid API key + funded wallet; this needs only the existing HELIUS_KEY.
   Decodes Pump TradeEvent ("Program data:" logs) and hands PumpPortal-shaped messages to the page. No keys, no signing. */
const WebSocket = require("ws"), bs58 = require("bs58");
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const DISC = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);   // TradeEvent
const b58 = bs58.encode || (bs58.default && bs58.default.encode);

/* TradeEvent after the 8-byte discriminator: mint32 | sol u64 | token u64 | isBuy u8 | user32 | ts i64 | vSol u64 | vTok u64 | ... */
function decodeTrade(buf) {
  if (buf.length < 8 + 113 || !buf.subarray(0, 8).equals(DISC)) return null;
  const d = buf.subarray(8), vSol = d.readBigUInt64LE(89), vTok = d.readBigUInt64LE(97);
  if (vTok === 0n) return null;
  return {
    mint: b58(d.subarray(0, 32)), solAmount: Number(d.readBigUInt64LE(32)) / 1e9, tokenAmount: Number(d.readBigUInt64LE(40)) / 1e6,
    txType: d[48] === 1 ? "buy" : "sell", traderPublicKey: b58(d.subarray(49, 81)),
    vSolInBondingCurve: Number(vSol) / 1e9, marketCapSol: Number(vSol) * 1e6 / Number(vTok)   // 1e9 supply, 6 decimals
  };
}
function decodeLogs(logs, signature, slot) {
  const out = [];
  for (const l of logs || []) {
    if (!l.startsWith("Program data: ")) continue;
    let b; try { b = Buffer.from(l.slice(14), "base64"); } catch { continue; }
    const t = decodeTrade(b); if (t) { t.signature = signature; t.slot = slot; out.push(t); }
  }
  return out;
}

/* start({key, getTracked, push, log}) - getTracked(): Promise<string[]> mints the page follows; push(arr): delivers trades. */
function start({ key, getTracked, push, log = console.log }) {
  const st = { msgs: 0, trades: 0, sent: 0, connected: false, since: Date.now() };
  let ws = null, retry = 0, tracked = new Set(), buf = [], recent = [], stopped = false;
  const connect = () => {
    if (stopped) return;
    ws = new WebSocket((process.env.HELIUS_WS || "wss://mainnet.helius-rpc.com/") + "?api-key=" + key);
    ws.on("open", () => { retry = 0; st.connected = true; log("helius feed connected");
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [PUMP] }, { commitment: "confirmed" }] })); });
    ws.on("message", d => {
      let m; try { m = JSON.parse(d); } catch { return; }
      const v = m.params && m.params.result && m.params.result.value; if (!v || v.err) return;
      st.msgs++;
      for (const t of decodeLogs(v.logs, v.signature, m.params.result.context && m.params.result.context.slot)) {
        st.trades++;
        if (tracked.has(t.mint)) buf.push(t);
        else { recent.push({ t, at: Date.now() }); if (recent.length > 20000) recent.splice(0, 5000); }
      }
    });
    const down = () => { st.connected = false; if (stopped) return; setTimeout(connect, Math.min(30000, 1500 * 2 ** Math.min(retry++, 5)) + Math.random() * 1000); };
    ws.on("close", down); ws.on("error", e => { log("helius feed error: " + e.message); try { ws.close(); } catch {} });
  };
  const flush = async () => {
    if (!buf.length) return; const a = buf; buf = [];
    try { await push(a); st.sent += a.length; } catch (e) { log("helius push failed: " + e.message); }
  };
  const refresh = async () => {   // learn which launches the page tracks; replay trades seen before the token was known (<20 s)
    try {
      const cur = new Set(await getTracked()), fresh = [...cur].filter(m => !tracked.has(m)); tracked = cur;
      if (fresh.length) { const fs = new Set(fresh), cut = Date.now() - 20000;
        for (const r of recent) if (fs.has(r.t.mint) && r.at >= cut) buf.push(r.t);
        recent = recent.filter(r => r.at >= cut && !cur.has(r.t.mint)); }
    } catch {}
  };
  setInterval(flush, 300); setInterval(refresh, 1500);
  setInterval(() => { // ping so idle proxies don't cut the socket; drop stale half-open connections
    if (ws && ws.readyState === 1) try { ws.ping(); } catch {}
    if (st.connected && st.msgs === 0 && Date.now() - st.since > 90000 && ws) { log("helius feed silent, reconnecting"); try { ws.terminate(); } catch {} st.since = Date.now(); }
  }, 30000);
  connect();
  return { stats: () => ({ ...st }), stop: () => { stopped = true; try { ws.close(); } catch {} } };
}
module.exports = { start, decodeTrade, decodeLogs };
