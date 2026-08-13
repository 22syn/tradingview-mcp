# tradingview-mcp

A standalone MCP server for TradingView automation: chart screenshots, watchlist CRUD by name, price alerts, and session status. Runs in-process via `tsx` (no compiled output needed).

## What it is

An MCP server exposing 11 tools — some drive a persistent Chromium profile via Playwright (chart screenshots, read/add/remove symbols in named watchlists, login state), others hit TradingView's public endpoints with no login (screener, watchlist data, shared-watchlist reads). Because it uses a persistent profile, you log in once interactively and all subsequent browser tool calls reuse that session.

## Setup

### 1. Install

```bash
git clone https://github.com/22syn/tradingview-mcp.git
cd tradingview-mcp
npm install
npx playwright install chromium
```

### 2. One-time login

```bash
npm run login
```

This opens a non-headless Chromium window pointed at TradingView's sign-in page. Log in with your TradingView credentials, then close the browser window. The session is saved in the persistent profile and reused for all future tool calls.

> If you already have a logged-in Playwright/Chromium profile for TradingView, set `TV_PROFILE_DIR` to point at it and skip the login step.

## Tools

| Tool | Description |
|------|-------------|
| `tv_screenshot` | Screenshot a symbol's TradingView chart. Required: `symbol`. Optional: `interval` (single) or `intervals` (array, max 4). Returns base64 PNG image(s). |
| `tv_read_watchlist` | Read the symbols in a named TradingView watchlist. Required: `watchlist`. |
| `tv_add_symbols` | Add symbols to a named watchlist (creates the list if it doesn't exist). Required: `watchlist`, `symbols` (array). |
| `tv_remove_symbols` | Remove symbols from a named watchlist. Required: `watchlist`, `symbols` (array). |
| `tv_session_status` | Report whether the saved profile is currently logged in. Returns `{ loggedIn, profileDir }`. |
| `tv_create_alert` | Create a price alert. Required: `symbol`, `price`. Optional: `condition` (`crossing` / `crossing_up` / `crossing_down`, default **crossing_down**), `message`. Bare tickers are auto-qualified. Idempotent — a matching alert is not duplicated. |
| `tv_list_alerts` | List the account's alerts as the alerts panel shows them. Returns `{ count, alerts: [{ description, detail }] }`. |
| `tv_delete_alert` | Delete **every** alert whose title contains `description_contains`. Destructive and matches broadly — list first. Returns `{ deleted, removed, remaining }`. |

### Alerts — two things to know

**The level gets rounded to the instrument's tick.** Asking for `19322` on `TASE:NXSN` stores
`19,320`. `tv_create_alert` reports the level TradingView actually kept, and the idempotency
check allows 0.1% so a rounded level is not mistaken for a new one and duplicated.

**Qualify or fail loudly.** An unqualified or wrong-exchange symbol makes TradingView answer
with a modal — "Can't create alert on invalid symbol" — that the tool cannot read back. Bare
tickers are resolved through the same symbol search the screener uses (`ONTO` → `NYSE:ONTO`);
pass `EXCHANGE:SYMBOL` yourself to skip it.

## Data tools (no login required)

These hit TradingView's public endpoints directly — they work even when `tv_session_status` reports `loggedIn:false`.

| Tool | Purpose | Example |
|------|---------|---------|
| `tv_screener` | Market-wide scan by technical filters | `{ "filters": [{"field":"rvol","op":"gt","value":2}, {"field":"rsi","op":"lt","value":30}], "limit": 20 }` |
| `tv_watchlist_data` | Pull quote data for every symbol in a list (TV watchlist, direct array, or Google Sheet) | `{ "symbols": ["AAPL","NVDA"] }` or `{ "watchlist": "My List" }` or `{ "sheet": "<sheet-id-or-url>", "tab": "Semis" }` |
| `tv_read_shared_watchlist` | Read symbols from a **shared/public** watchlist URL (no login) | `{ "url": "https://www.tradingview.com/watchlists/<id>/" }` |

**Filter fields (tv_screener):** `rvol`, `rsi`, `volume`, `close`, `change`, `macd`, `sma20`/`sma50`/`sma200`, `recommend`.
**Operators:** `gt`, `lt`, `gte`, `lte`, `eq`, `between` (value = `[min,max]`).
**Markets:** `america` (default), `crypto`. Inferred from the symbol prefix when omitted.
**Bare tickers** (e.g. `AAPL`) are auto-qualified to `EXCHANGE:SYMBOL` via TradingView symbol search before scanning.

> **Note:** all symbols in one `tv_watchlist_data` (or `tv_screener`) call are scanned against a single market — inferred from the first symbol, or set via `market`. Symbols from a different market are silently omitted (the response's `count` vs `requested` reveals the drop). For mixed-market lists (e.g. US equities + crypto), split into separate calls per market.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TV_PROFILE_DIR` | `~/.cache/tradingview-mcp/profile` | Path to the persistent Chromium profile directory. Point this at an existing logged-in profile to skip `npm run login`. |
| `TV_HEADED` | unset (headless) | Set to any value to run Chromium with a visible window (useful for debugging). |

## Register with Claude Code

```bash
claude mcp add tradingview --scope user -- npx tsx /path/to/tradingview-mcp/src/server.ts
```

Replace `/path/to/tradingview-mcp` with the absolute path where you cloned the repo. After registering, reload Claude Code (or start a new session). The 11 `tv_*` tools will be available.

## Development

```bash
# Type-check
npm run typecheck

# Run unit tests (no browser required)
npm test

# Run the server directly (stdio MCP protocol)
npm start
```

## Reading a friend's shared watchlist

`tv_read_shared_watchlist` reads the symbols from any TradingView **shared/public**
watchlist URL (e.g. `https://www.tradingview.com/watchlists/<id>/`) — **no login**.
It parses the symbols embedded in the public share page and drops section-header rows,
returning `{ url, count, symbols }` with exchange-qualified tickers.

```
{ "url": "https://www.tradingview.com/watchlists/<id>/" }
→ { "url": "...", "count": 64, "symbols": ["NASDAQ:NVDA", ...] }
```

For the friend to expose a list: open it in advanced view, enable **"Share list"**, and
send the link. Keep sharing on — the link stays live (do **not** "copy to myself"; that
is a static snapshot).

> **Tip:** you can feed the symbols returned here straight into `tv_watchlist_data` (or a
> Google Sheet) to build a scan universe from one or more shared lists. This MCP provides
> the read capability; what you do with the symbols downstream is up to you.

## Security & privacy

- **Local-first.** Everything runs on your machine. There is no hosted backend, no proxy, and no third party — your data and your TradingView session never leave your computer.
- **Your own login.** Browser tools reuse a persistent Chromium profile that *you* log into interactively (`npm run login`). No credentials, cookies, tokens, or API keys are ever read, stored, or transmitted by this code. Your session lives only in the local profile directory (`~/.cache/tradingview-mcp/profile` by default), which is outside the repo and never committed.
- **No secrets in the repo.** There is nothing to leak — grep the source and you'll find no keys or tokens. Screenshots are written to the OS temp directory and deleted immediately after they're read.
- **Public endpoints only.** The data tools (`tv_screener`, `tv_watchlist_data`, `tv_read_shared_watchlist`) call TradingView's and Google Sheets' *public* endpoints with no authentication.

## Disclaimer

This is an **unofficial** project and is **not affiliated with, endorsed by, or sponsored by TradingView**. It automates a browser session you log into yourself and reads public endpoints. Use it in accordance with TradingView's Terms of Service. Nothing here is financial advice.

## Contributing

Issues and pull requests are welcome — new screener fields, additional markets, other data endpoints, or Windows/Linux profile notes. Please keep the "no secrets, local-first" posture intact: don't add anything that requires committing credentials.

## License

[MIT](LICENSE) © Kobi Hazout
