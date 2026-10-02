# CLAUDE.md — tradingview-mcp
> 📋 **Active plan (2026-07-23):** [docs/plans/2026-07-23-graph-audit-followup.md](docs/plans/2026-07-23-graph-audit-followup.md) — graph-audit follow-up; review before structural changes.
> 📋 **Improvement plan (2026-07-23):** [docs/plans/2026-07-23-improvement-plan.md](docs/plans/2026-07-23-improvement-plan.md) — add a driver.ts unit test, clean up leftover worktrees.

## Purpose

A standalone MCP server for TradingView automation. Exposes tools to take chart
screenshots, do watchlist CRUD by name, run market-wide technical screeners, and
check login state. Runs in-process via `tsx` (no build step).

## Stack

- Node.js + TypeScript (CommonJS, run directly with `tsx` — no compiled output)
- `@modelcontextprotocol/sdk` — MCP server framework
- `playwright` — drives a persistent Chromium profile for logged-in TradingView actions
- Data tools also hit TradingView's public endpoints directly (no login needed)

## Structure

- `src/server.ts` — MCP entry point; registers and dispatches the tools (also the `bin`)
- `src/driver.ts` — TradingView interaction logic (screenshots, watchlist ops)
- `src/browser.ts` — persistent Chromium profile / Playwright setup
- `src/scanner.ts` — screener + watchlist-data logic against public endpoints
- `src/shared-watchlist.ts` — read a shared/public watchlist from its URL (no login)
- `src/chart-data.ts` — read bars + on-layout indicator values from the chart's internal `window.TradingViewApi` (undocumented; can break on a TV release)
- `src/login.ts` — one-time interactive login flow (`npm run login`)
- `src/alert-diagnostics.ts` — on any `tv_create_alert` failure, saves a screenshot + JSON snapshot of the dialog (data-qa-ids, inputs, other modals, HTML) to `.diagnostics/` (override with `TV_DIAG_DIR`; newest 30 sets kept; gitignored). The failure result carries `diagnostics` (path stem). Added after THEON failed `price input not found` 7 runs with no way to tell why. The in-page snapshot is a *string* script on purpose (tsx injects `__name` into functions); `test/alert-diagnostics.browser.test.ts` runs it in real Chromium and skips if none is installed.
- `test/` — unit tests (`driver.test.ts`, `scanner.test.ts`, `shared-watchlist.test.ts`, `alerts.test.ts`, `chart-data.test.ts`, `alert-diagnostics.test.ts`; `alert-diagnostics.browser.test.ts` is the one test that launches Chromium), no browser required

## Run / dev

```bash
npm install
npx playwright install chromium
npm run login       # one-time interactive TradingView sign-in
npm start           # run the server over stdio MCP protocol
npm test            # unit tests (no browser)
npm run typecheck   # tsc --noEmit
```

Register with Claude Code:
```bash
claude mcp add tradingview --scope user -- npx tsx /path/to/tradingview-mcp/src/server.ts
```

## Conventions / notes

- Login-based tools reuse a persistent Chromium profile — log in once, sessions persist.
- Login-required tools: `tv_screenshot`, `tv_chart_data`, `tv_read_watchlist`, `tv_add_symbols`,
  `tv_remove_symbols`, `tv_session_status`.
- `tv_chart_data` usually gets a substitute venue (NASDAQ:AAPL → BATS:AAPL). Prices and daily volume
  match the scanner, but intraday bar volume is single-venue (4–10% of real) — never derive RVOL from it.
- Data tools (no login): `tv_screener`, `tv_watchlist_data`, `tv_read_shared_watchlist` — hit public endpoints.
- One `tv_screener` / `tv_watchlist_data` call scans a single market (inferred from
  the first symbol, or set via `market`); mixed-market lists must be split per call.
- Env vars: `TV_PROFILE_DIR` (persistent profile path; point at an existing logged-in
  profile to skip login), `TV_HEADED` (set to run Chromium with a visible window).
