# Improvement plan — 2026-07-23

## Context
Hybrid tool: Playwright browser automation for anything requiring login (watchlists, screenshots), lightweight scraping of TradingView's public endpoints for screener/quote data. Extracted from smart-volume-radar's TradingView sync, deliberately kept independent (not de-duplicated) by design. Fragility is real and already well-documented in the code's own comments — this plan doesn't uncover new risk, it just tracks what the code already flags.

## Tasks
- [ ] Add a browser-independent unit test for `driver.ts` — the only genuinely flagged gap from today's graph audit (scanner.ts and shared-watchlist.ts already have tests, driver.ts doesn't) — **Verify:** test exists, passes without a live browser
- [ ] Clean up 2 leftover prunable `.claude/worktrees/` directories from prior agent sessions — **Verify:** `git worktree list` clean
- [ ] No action needed on: Alerts CRUD (deliberately deferred, no concrete need yet), Telegram delivery (intentionally left to the radar project), de-duplication with smart-volume-radar's copy (declined by design — only revisit if this becomes an installable npm package)
- [ ] If TradingView scanner calls become frequent enough to risk throttling, consider basic rate-limiting on `scanner.ts` — currently zero protection exists — **Verify:** only if this becomes an actual problem, not preemptively
