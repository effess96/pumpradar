# PumpRadar

Read-only pump.fun companion: live scanner with on-chain safety scoring, pre-trade checker, top-trader tracking, paper-trading bots, wallet P&L (FIFO), risk rules and journal.

**Open it:** https://effess96.github.io/pumpradar/

## Rules
- Read-only. It only ever asks for a public wallet address, never a private key or seed phrase.
- No auto-trading. The bots trade fake money; any real trade is placed by hand.
- Your Helius API key and all data stay in your own browser's localStorage. Nothing is stored in this repo.

## Use
1. Open the link in Chrome and add a free Helius key under **Settings**.
2. Open **Paper bot**, enable desktop alerts and leave the tab open.
3. Follow the **What to do now** panel. It says "nothing" until a bot passes the copy-readiness checks.

Data: PumpPortal WebSocket, DexScreener, Helius RPC, Jupiter quotes.
