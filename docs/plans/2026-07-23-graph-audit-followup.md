> NEXT SESSION: review this plan before making structural changes to this repo, and report status to Kobi.

# Graph-Audit Follow-up — tradingview-mcp (2026-07-23)

## Graph snapshot

- **Code symbols:** 68 (129 total nodes) — small, healthy MCP server.
- **Top hubs (god nodes):**
  - `src/scanner.ts` — degree 34
  - `src/server.ts` — degree 28
  - `src/driver.ts` — degree 16
  - `test/scanner.test.ts` — degree 15
  - `log()` (`src/driver.ts`) — degree 6
- **Import cycles:** none.
- **Age:** 0 days since last commit (actively worked).
- **Zero-edge nodes:** 0.

## Change-risk hotspots

- `src/scanner.ts` — screener + watchlist-data logic against TradingView's public endpoints; the single most-connected module and already unit-tested (`scanner.test.ts`). Keep tests in step when changing its endpoint parsing.
- `src/server.ts` — MCP entry point registering/dispatching the tools; a change here affects every exposed tool's contract.
- `src/driver.ts` — Playwright browser-interaction logic (screenshots, watchlist ops).

Degrees are modest (max 34) and the two heaviest files are cleanly split (public-endpoint data vs. logged-in browser actions), so blast radius is contained.

## Action items

**No structural action required — maintenance / watch-list only.**

- Healthy small repo: no cycles, no dead code (0 zero-edge nodes), no oversized hubs, and the highest-connectivity file (`scanner.ts`) already has test coverage.
- Only genuine watch item: `driver.ts` (Playwright) has no browser-independent unit test alongside `scanner`/`shared-watchlist`. If browser automation grows more complex, consider a thin test seam — noted as optional, not graph-mandated.
