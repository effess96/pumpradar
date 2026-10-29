"use strict";
/*
 * PumpRadar 24/7 server.
 * Runs the exact PumpRadar app (index.html?engine=1) in headless Chromium so the bots trade paper around the clock,
 * serves the app to your phone as a remote control, proxies read-only Helius calls, and sends Telegram alerts.
 * Read-only: no wallet, no private keys, no trading. Secrets come from environment variables only.
 */
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { chromium } = require("playwright");

const PORT = +process.env.PORT || 8080;
const KEY = (process.env.HELIUS_KEY || "").trim();
const TOKEN = (process.env.DASH_TOKEN || "").trim();
const DATA = process.env.DATA_DIR || "/data";
const TG = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TG_PRACTICE = (process.env.TELEGRAM_PRACTICE || "1") !== "0";
const TZ = process.env.REPORT_TZ || "Asia/Amman";
const PAPER_ONLY = (process.env.PAPER_ONLY || "1") !== "0";   // belt and braces: forces PRACTICE on every Telegram alert
const PUB = path.join(__dirname, "public");
// The auto-trader (and its Solana libraries) load only when explicitly enabled, so a problem there can never stop the paper server from booting.
let makeTrader = null;
if (process.env.AUTO_TRADE === "1") { try { ({ makeTrader } = require("./trader")); } catch (e) { console.error("auto-trader failed to load, staying disabled:", e.message); } }

if (TOKEN.length < 12) { console.error("Set DASH_TOKEN to a random string of 12+ characters."); process.exit(1); }
if (!KEY) console.warn("HELIUS_KEY is not set: bots that require on-chain scans won't trade.");
fs.mkdirSync(DATA, { recursive: true });

const RPC_OK = new Set(["getAccountInfo", "getTokenLargestAccounts", "getMultipleAccounts", "getTokenAccountsByOwner", "getBalance", "getSignaturesForAddress", "getAsset"]);
const MIME = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".png": "image/png", ".js": "text/javascript" };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function authed(req) {
  const a = Buffer.from(String(req.headers["x-token"] || "")), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type, "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,x-token",
    "access-control-allow-methods": "GET,POST,OPTIONS", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, max = 1e6) {
  return new Promise((ok, no) => {
    let n = 0; const c = [];
    req.on("data", d => { n += d.length; if (n > max) { no(new Error("body too large")); req.destroy(); } else c.push(d); });
    req.on("end", () => ok(Buffer.concat(c).toString())); req.on("error", no);
  });
}

/* ---------------- engine: the app itself, headless ---------------- */
let ctx = null, page = null, engineOk = false, starting = false, lastState = null, lastStateAt = 0;
async function startEngine() {
  if (starting) return; starting = true; engineOk = false;
  try {
    if (ctx) await ctx.close().catch(() => {});
    const dir = path.join(DATA, "chrome");
    for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) fs.rmSync(path.join(dir, f), { force: true });
    ctx = await chromium.launchPersistentContext(dir, { headless: true, executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
    await ctx.addInitScript(`window.__PR_ENGINE_KEY__=${JSON.stringify(KEY)};`);
    if (process.env.PR_TEST_INIT) await ctx.addInitScript({ path: process.env.PR_TEST_INIT });   // tests only
    await ctx.exposeFunction("__prSignal", p => { onSignal(p).catch(e => console.error("telegram:", e.message)); });
    page = ctx.pages()[0] || await ctx.newPage();
    page.on("pageerror", e => console.error("page error:", e.message));
    page.on("crash", () => { console.error("page crashed, restarting"); engineOk = false; setTimeout(startEngineSafe, 3000); });
    await page.goto(`http://127.0.0.1:${PORT}/?engine=1`, { waitUntil: "load", timeout: 60000 });
    engineOk = true; console.log("engine running");
    startHeliusFeed();
  } finally { starting = false; }
}
let hFeed = null;   // Helius trade feed (PumpPortal trade streams are paid now); read-only, uses HELIUS_KEY only
function startHeliusFeed() {
  if (hFeed || !KEY || process.env.HELIUS_FEED === "0") return;
  try {
    hFeed = require("./helius-feed").start({ key: KEY,
      getTracked: () => engineOk ? page.evaluate(() => window.__trackedMints ? window.__trackedMints() : []) : [],
      push: arr => engineOk ? page.evaluate(a => window.__feedTrades && window.__feedTrades(a), arr) : null });
    setInterval(() => { if (engineOk) page.evaluate(s => { window.__feedStat = s; }, hFeed.stats()).catch(() => {}); }, 20000);
  } catch (e) { console.error("helius feed failed to start:", e.message); }
}
// Give the page the trader's real open-position count, so Phase 4 cards don't warn "wallet not loaded".
setInterval(() => { if (engineOk && trader && trader.enabled()) page.evaluate(n => { window.__traderOpen = n; }, trader.openCount()).catch(() => {}); }, 20000);
async function startEngineSafe() { try { await startEngine(); } catch (e) { console.error("engine start failed:", e.message); setTimeout(startEngineSafe, 15000); } }
async function ev(fn, arg) {
  if (!engineOk) throw new Error("engine starting, try again in a minute");
  return Promise.race([page.evaluate(fn, arg), sleep(20000).then(() => { throw new Error("engine timeout"); })]);
}
setInterval(async () => {                 // watchdog
  if (starting) return;
  try { await ev(() => typeof exportState); } catch (e) { console.error("watchdog:", e.message); startEngineSafe(); }
}, 60000);
setInterval(async () => {                 // reload twice a day to keep memory flat
  try { await ev(() => persist()); await page.reload({ waitUntil: "load" }); console.log("engine reloaded"); } catch {}
}, 12 * 3600e3);

/* ---------------- HTTP: app + API ---------------- */
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://x"), p = u.pathname;
    if (req.method === "OPTIONS") return send(res, 204, "");
    if (p === "/pub/trader") {   // read-only bot status for the HQ map (no auth, no secrets)
      if (!trader) return send(res, 200, { mode: "off" });
      if (Date.now() - pubAt > 15000) { pubSnap = await trader.snapshot().catch(e => ({ mode: "error", error: e.message })); pubAt = Date.now(); }
      return send(res, 200, pubSnap);
    }
    if (p === "/api/ping") return send(res, 200, { ok: true, engine: engineOk });
    if (p.startsWith("/api/")) {
      if (!authed(req)) return send(res, 401, { error: "unauthorized" });
      if (p === "/api/state") {
        if (Date.now() - lastStateAt > 2000) { lastState = await ev(() => exportState()); lastStateAt = Date.now(); }
        return send(res, 200, lastState);
      }
      if (p === "/api/hist") return send(res, 200, await ev(() => hist));
      if (p === "/api/cmd" && req.method === "POST") {
        const c = JSON.parse(await readBody(req)); await ev(c => applyCmd(c), c); lastStateAt = 0;
        return send(res, 200, { ok: true });
      }
      if (p === "/api/rpc" && req.method === "POST") {
        const b = JSON.parse(await readBody(req));
        if (!RPC_OK.has(b.method)) return send(res, 400, { error: "method not allowed" });
        const r = await fetch("https://mainnet.helius-rpc.com/?api-key=" + encodeURIComponent(KEY), { method: "POST",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: b.method, params: b.params }) });
        return send(res, r.status, await r.text());
      }
      if (p === "/api/helius/transactions" && req.method === "POST") {
        const b = JSON.parse(await readBody(req));
        const sigs = (Array.isArray(b.transactions) ? b.transactions : []).filter(s => /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(s)).slice(0, 100);
        const r = await fetch("https://api.helius.xyz/v0/transactions?api-key=" + encodeURIComponent(KEY), { method: "POST",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ transactions: sigs }) });
        return send(res, r.status, await r.text());
      }
      const m = p.match(/^\/api\/helius\/addr\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (m) {
        const q = new URLSearchParams({ limit: String(Math.min(100, +u.searchParams.get("limit") || 100)) });
        const before = u.searchParams.get("before"); if (before && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(before)) q.set("before", before);
        const r = await fetch(`https://api.helius.xyz/v0/addresses/${m[1]}/transactions?api-key=${encodeURIComponent(KEY)}&${q}`);
        return send(res, r.status, await r.text());
      }
      return send(res, 404, { error: "not found" });
    }
    const f = p === "/" ? "/index.html" : p, fp = path.join(PUB, path.normalize(f));
    if (!fp.startsWith(PUB + path.sep) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) return send(res, 404, "not found", "text/plain");
    let body = fs.readFileSync(fp);
    if (f === "/index.html" && !u.searchParams.has("engine"))   // the phone gets remote-control mode
      body = Buffer.from(body.toString().replace('<script>\n"use strict";', '<script>window.__PR_SERVER__=1;</script>\n<script>\n"use strict";'));
    return send(res, 200, body, MIME[path.extname(fp)] || "application/octet-stream");
  } catch (e) { console.error(req.method, req.url, e.message); send(res, 500, { error: e.message }); }
});

/* ---------------- Telegram ---------------- */
const TGF = path.join(DATA, "telegram.json");
let tgState = { chat: null, offset: 0 };
try { tgState = { ...tgState, ...JSON.parse(fs.readFileSync(TGF, "utf8")) }; } catch {}
if (process.env.TELEGRAM_CHAT_ID) tgState.chat = String(process.env.TELEGRAM_CHAT_ID);
const saveTg = () => { try { fs.writeFileSync(TGF, JSON.stringify(tgState)); } catch {} };
async function tg(method, params) {
  if (!TG) return null;
  const r = await fetch(`https://api.telegram.org/bot${TG}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) });
  return r.json().catch(() => null);
}
const h = s => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const K = n => n == null || isNaN(n) ? "—" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : (+n).toFixed(0);
let trader = null, pubSnap = null, pubAt = 0;   // created after tg() exists (see below)
async function onSignal(p) {
  if (trader && trader.enabled()) {          // auto-trader acts on the raw signal (its own gate + hard limits), independent of Telegram
    const buy0 = String(p.kind).startsWith("BUY");
    (buy0 ? trader.onBuySignal(p) : trader.onSellSignal(p)).catch(e => console.error("trader:", e.message));
  }
  if (!TG || !tgState.chat) return;
  if (PAPER_ONLY) p.practice = true;
  if (p.practice && !TG_PRACTICE) return;
  const buy = String(p.kind).startsWith("BUY");
  const head = `${buy ? "🟢" : "🔴"} <b>${h(p.kind)} ${h(p.sym)}</b> · ${p.practice ? "🟡 PRACTICE (paper only)" : "COPY"}`;
  const blocked = buy && p.gate && p.gate.blocks && p.gate.blocks.length;
  const act = buy
    ? (blocked ? `⛔ <b>BLOCKED by Phase 4 gate. Skip.</b>\n• ${p.gate.blocks.map(h).join("\n• ")}` :
       p.practice ? "Real size: $0. Practice signal, don't use real money." : p.locked ? "⛔ Your rules locked you out today. Skip." :
       `Your size: <b>$${(+p.sizeUsd).toFixed(2)}</b>${p.sizeSol ? ` (${(+p.sizeSol).toFixed(3)} SOL)` : ""}`)
    : (p.kind === "SELL ALL" ? "Sell <b>all</b> of it." : `Sell <b>${h(String(p.kind).replace("SELL ", ""))}</b> of your position.`);
  const warn = buy && p.gate && p.gate.warns && p.gate.warns.length ? `\n⚠️ ${p.gate.warns.map(h).join(" · ")}` : "";
  const plan = buy && !blocked ? `\nPhase 4 gate: ✅ all hard checks pass.${warn}\nPlan: sell half at ${p.tp}x, everything at −${p.sl}%. Run the autopsy, and skip if this is older than 30 s.` : (blocked ? warn : "");
  await tg("sendMessage", { chat_id: tgState.chat, parse_mode: "HTML", disable_web_page_preview: true,
    text: `${head}\n${act}\nMC $${K(p.mc)} · ${h(p.why)}\nBot: ${h(p.bot)}${plan}`,
    reply_markup: { inline_keyboard: [[{ text: "Open in pump.fun", url: `https://pump.fun/coin/${p.mint}` }]] } });
}
trader = !makeTrader ? null : makeTrader({ dataDir: DATA, heliusKey: KEY, tz: TZ,
  getMc: async m => engineOk ? page.evaluate(x => { const t = tokens.get(x); return t && t.mcSol ? t.mcSol : null; }, m) : null,
  pin: async a => { if (engineOk) await page.evaluate(x => window.__setPinned && window.__setPinned(x), a); },
  notify: t => (TG && tgState.chat ? tg("sendMessage", { chat_id: tgState.chat, text: t, parse_mode: "HTML", disable_web_page_preview: true }).catch(() => {}) : null) });
async function statusText() {
  const s = await ev(() => statusSummary());
  if (PAPER_ONLY && s.following) s.following.practice = true;
  const L = [`<b>PumpRadar</b> · feed ${s.feed ? "live ✅" : "down ⚠️"} · ${s.tokens} tokens tracked`];
  L.push(s.following ? `Following <b>${h(s.following.name)}</b> · ${s.following.practice ? "🟡 PRACTICE (don't use real money)" : "🟢 COPY-READY"}` : "All bots are stopped.");
  if (s.pos.length) L.push("Open: " + s.pos.map(p => `${h(p.sym)} ${p.x.toFixed(2)}x`).join(", "));
  L.push("", "<b>Bot race</b> (50 trades + 5/5 checks = ready)");
  for (const b of s.race) L.push(`${b.ready ? "✅" : "▫️"} ${h(b.name)}: ${b.closed}/50 · ${b.checks}/5 · ${b.ret == null ? "—" : (b.ret > 0 ? "+" : "") + b.ret.toFixed(1) + "%"}${b.on ? "" : " (stopped)"}`);
  L.push(`Learned model: ${s.learn.n}/${s.learn.min} outcomes`);
  if (s.evo) L.push(`Evolution: ${h(s.evo.s)}`);
  if (s.lab && s.lab.length) L.push("", "<b>Lab</b> (send /lab for the full report)", ...s.lab.map(h));
  return L.join("\n");
}
async function tgLoop() {
  if (!TG) { console.log("Telegram off (no TELEGRAM_BOT_TOKEN)"); return; }
  for (;;) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TG}/getUpdates?timeout=25&offset=${tgState.offset}`, { signal: AbortSignal.timeout(35000) });
      const j = await r.json();
      for (const up of j.result || []) {
        tgState.offset = up.update_id + 1;
        const m = up.message; if (!m || !m.text) continue;
        const chat = String(m.chat.id), txt = m.text.trim();
        if (!tgState.chat && txt.startsWith("/start")) {
          tgState.chat = chat;
          await tg("sendMessage", { chat_id: chat, text: "✅ PumpRadar linked to this chat. BUY/SELL signals will arrive here. Send /status any time." });
        } else if (chat !== String(tgState.chat)) continue;              // only the owner's chat
        else if (txt.startsWith("/status")) await tg("sendMessage", { chat_id: chat, text: await statusText().catch(e => "Engine: " + e.message), parse_mode: "HTML" });
        else if (txt.startsWith("/lab")) {
          const lines = await ev(() => labReport(true)).catch(e => ["Engine: " + e.message]);
          await tg("sendMessage", { chat_id: chat, text: ("<b>Lab report</b>\n<pre>" + h(lines.join("\n").slice(0, 3500)) + "</pre>"), parse_mode: "HTML" });
        } else {
          const tr = trader ? await trader.command(txt).catch(e => "Trader: " + e.message) : null;
          await tg("sendMessage", { chat_id: chat, text: tr || (trader ? "Commands: /status /lab /trader /stop /resume /sellall" : "Commands: /status /lab"), parse_mode: "HTML", disable_web_page_preview: true });
        }
      }
      saveTg();
    } catch { await sleep(5000); }
  }
}
let lastDaily = "";
setInterval(async () => {                 // 21:00 daily report
  if (!TG || !tgState.chat || !engineOk) return;
  const now = new Date();
  const hh = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(now);
  const day = now.toLocaleDateString("en-CA", { timeZone: TZ });
  if (hh === "21" && lastDaily !== day) { lastDaily = day; try { await tg("sendMessage", { chat_id: tgState.chat, text: "🌙 Daily report\n" + await statusText(), parse_mode: "HTML" }); } catch {} }
}, 60000);

server.listen(PORT, "0.0.0.0", () => { console.log("PumpRadar server on port", PORT); startEngineSafe(); tgLoop(); });
process.on("SIGTERM", async () => { try { await ev(() => persist()); } catch {} try { await ctx?.close(); } catch {} process.exit(0); });
