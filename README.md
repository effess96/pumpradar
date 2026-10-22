# PumpRadar

Read-only pump.fun companion: live scanner with on-chain safety scoring, pre-trade checker, top-trader tracking, paper-trading bots (incl. a self-learning bot and auto-evolving strategies), wallet P&L (FIFO), risk rules and a phone-first **Follow** screen that tells you what to do.

- **Phone / browser app:** https://effess96.github.io/pumpradar/ (bots run only while the page is open)
- **24/7 server:** deploy this repo to Railway (below). The bots then run around the clock, your phone becomes a remote control, and signals arrive on Telegram even with the phone locked.

## Rules
- Read-only. Only a public wallet address is ever used. Never a private key or seed phrase.
- No auto-trading. Bots trade fake money; any real trade is placed by you, by hand.
- Secrets (Helius key, access token, Telegram token) live only in server environment variables or your own browser. Nothing secret is in this repo.

## Deploy the 24/7 server on Railway (works from an iPhone)
1. Go to **railway.com** and sign in with GitHub (effess96). A Hobby plan is $5/month and includes $5 of usage; this server typically needs about $5–10/month in total.
2. **New Project → Deploy from GitHub repo → effess96/pumpradar.** Allow Railway access to the repo if asked. It finds the `Dockerfile` by itself.
3. Open the service → **Variables** and add:
   | Name | Value |
   |---|---|
   | `HELIUS_KEY` | your Helius API key |
   | `DASH_TOKEN` | a long random password (20+ characters) you make up; it locks the server |
   | `TELEGRAM_BOT_TOKEN` | optional, from @BotFather (step 6) |
4. Add a **Volume** to the service with mount path **`/data`**. This keeps bot history across restarts.
5. Service → **Settings → Networking → Generate Domain**. Open that URL on your phone, go to **Settings**, paste your `DASH_TOKEN` into "Server access token" and save. Then **Share → Add to Home Screen**.
6. **Telegram alerts:** in Telegram, message **@BotFather** → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN` (Railway redeploys). Open your new bot and send `/start` straight away; the first chat to do so is locked in as the only one that receives alerts. Send `/status` any time; a daily report arrives at 21:00 Amman time.

Optional variables: `TELEGRAM_PRACTICE=0` to stop practice-signal messages, `TELEGRAM_CHAT_ID` to pin the chat, `REPORT_TZ` for the daily report time zone.

## How following works
- **Follow tab:** big BUY / SELL / WAIT cards, your size from your risk rules, one tap to open the token in pump.fun, and exit levels for open positions.
- **PRACTICE vs COPY-READY:** until a bot has 50 closed paper trades and passes all 5 readiness checks, signals are marked PRACTICE with a real size of $0. Once one passes, it becomes the lead and signals say COPY with your size.
- **Learner bot:** learns from every token's real 1-hour outcome which features predict 2x runs and rugs (naive Bayes over flags, buyers, curve, sell pressure, velocity, smart wallets), and trades only when the odds favour it. It starts after 150 resolved outcomes.
- **Auto-evolve:** spawns tweaked copies of the best bot once it has 30 profitable trades and retires copies that lose money after 40.

Data: PumpPortal WebSocket, DexScreener, Helius RPC (read-only methods only), Jupiter quotes.
