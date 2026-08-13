#!/usr/bin/env -S npx tsx
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Page } from 'playwright';
import { getPage, PROFILE_DIR } from './browser';
import {
  isLoggedIn, openWatchlist, readCurrentSymbols, addSymbolsBulk, removeSymbol, captureChart,
} from './driver';
import { screener, qualifySymbols, fetchSheetSymbols, searchSymbol, QUOTE_COLUMNS, buildIndicatorColumns, parseScanResponse, scan, inferMarket } from './scanner';
import { fetchSharedWatchlist } from './shared-watchlist';
import { createAlert, deleteAlerts, listAlerts, CONDITIONS, type ConditionKey } from './alerts';

// Serialize tool calls — they all drive one shared browser page.
let lock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.then(() => {}, () => {});
  return run;
}

const SYMBOLS_SCHEMA = { type: 'array', items: { type: 'string' }, minItems: 1 };

const TOOLS = [
  { name: 'tv_screenshot', description: 'Screenshot a symbol\'s TradingView chart (saved layout). Optional interval / intervals (max 4).',
    inputSchema: { type: 'object', properties: {
      symbol: { type: 'string' }, interval: { type: 'string' },
      intervals: { type: 'array', items: { type: 'string' }, maxItems: 4 } },
      required: ['symbol'], additionalProperties: false } },
  { name: 'tv_read_watchlist', description: 'Read the symbols in a named TradingView watchlist.',
    inputSchema: { type: 'object', properties: { watchlist: { type: 'string' } }, required: ['watchlist'], additionalProperties: false } },
  { name: 'tv_add_symbols', description: 'Add symbols to a named watchlist (creates it if missing).',
    inputSchema: { type: 'object', properties: { watchlist: { type: 'string' }, symbols: SYMBOLS_SCHEMA }, required: ['watchlist', 'symbols'], additionalProperties: false } },
  { name: 'tv_remove_symbols', description: 'Remove symbols from a named watchlist.',
    inputSchema: { type: 'object', properties: { watchlist: { type: 'string' }, symbols: SYMBOLS_SCHEMA }, required: ['watchlist', 'symbols'], additionalProperties: false } },
  { name: 'tv_session_status', description: 'Report whether the saved TradingView profile is logged in.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'tv_read_shared_watchlist', description: 'Read the exchange-qualified symbols from a TradingView shared/public watchlist URL (e.g. https://www.tradingview.com/watchlists/<id>/). No login — parses the symbols embedded in the public share page. Section-header rows are dropped. Returns { url, count, symbols }.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } },
  { name: 'tv_screener', description: 'Scan the market for symbols matching technical filters (no login needed). Fields: rvol, rsi, volume, close, change, macd, sma20/50/200, recommend. Ops: gt, lt, gte, lte, eq, between. Returns ranked rows.',
    inputSchema: { type: 'object', properties: {
      filters: { type: 'array', items: { type: 'object', properties: {
        field: { type: 'string' }, op: { type: 'string' },
        value: {} }, required: ['field', 'op', 'value'], additionalProperties: false } },
      market: { type: 'string', description: 'america (default) or crypto' },
      sort: { type: 'object', properties: { field: { type: 'string' }, order: { type: 'string', enum: ['asc', 'desc'] } }, additionalProperties: false },
      limit: { type: 'number' } },
      required: ['filters'], additionalProperties: false } },
  { name: 'tv_watchlist_data', description: 'Pull data for every symbol in a list, in one call. Source (exactly one): watchlist (TV list name, needs login), symbols (array), or sheet (Google Sheet id/URL, public CSV). Default = quote snapshot (price/change/RVOL/RSI/recommend); pass indicators+timeframes for a TA matrix. Bare tickers are auto-qualified. Use `tab` to target a specific tab of a multi-tab sheet.',
    inputSchema: { type: 'object', properties: {
      watchlist: { type: 'string' },
      symbols: { type: 'array', items: { type: 'string' }, minItems: 1 },
      sheet: { type: 'string' },
      tab: { type: 'string', description: 'Optional sheet tab name (used with `sheet`).' },
      indicators: { type: 'array', items: { type: 'string' } },
      timeframes: { type: 'array', items: { type: 'string' } },
      market: { type: 'string' } },
      additionalProperties: false } },
  { name: 'tv_create_alert', description: 'Create a price alert on a symbol (needs login). Condition defaults to crossing_down, the direction a stop-loss cares about. Bare tickers are auto-qualified. Idempotent: an alert whose title already matches is not duplicated. Returns { created, description, existing?, error? }.',
    inputSchema: { type: 'object', properties: {
      symbol: { type: 'string', description: 'Ticker or EXCHANGE:SYMBOL, e.g. ONTO or NYSE:ONTO.' },
      price: { type: 'number' },
      condition: { type: 'string', enum: ['crossing', 'crossing_up', 'crossing_down'] },
      message: { type: 'string', description: 'Overrides the auto-generated alert title.' } },
      required: ['symbol', 'price'], additionalProperties: false } },
  { name: 'tv_list_alerts', description: 'List the price alerts currently in the account, as the alerts panel shows them (needs login). Returns { count, alerts: [{ description, detail }] }.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'tv_symbol_search', description: 'Resolve a ticker or company name to TradingView symbols (no login). Returns every venue with its currency and country so the caller can disambiguate — "ORA" is Orange on EURONEXT and Ormat on NYSE, and ranking alone picks the wrong one. Returns { query, count, results: [{ tvSymbol, description, exchange, currency, country, type }] }.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', minLength: 1 },
      limit: { type: 'number', description: 'Max results (default 10).' } },
      required: ['query'], additionalProperties: false } },
  { name: 'tv_delete_alert', description: 'Delete EVERY alert whose title contains the given text (case-insensitive, commas ignored). Destructive and matches broadly — pass enough of the title to be unambiguous, and use tv_list_alerts first to see what will match. Returns { deleted, removed, remaining }.',
    inputSchema: { type: 'object', properties: {
      description_contains: { type: 'string', minLength: 2, description: 'Substring of the alert title, e.g. "NXSN Crossing Down".' } },
      required: ['description_contains'], additionalProperties: false } },
];

function text(t: string) { return { content: [{ type: 'text', text: t }] }; }
function errText(t: string) { return { isError: true, content: [{ type: 'text', text: t }] }; }

let readyPage: Page | null = null;
let loggedInCache = false;
// Navigate to the chart + verify login once per page; cached on repeat calls.
async function ensureReady(page: Page): Promise<boolean> {
  if (readyPage === page) return loggedInCache;
  await page.goto('https://www.tradingview.com/chart/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(5000);
  loggedInCache = await isLoggedIn(page);
  readyPage = page;
  return loggedInCache;
}

const server = new Server({ name: 'tradingview', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) =>
  withLock(async () => {
  const name = req.params.name;
  const args: Record<string, unknown> = (req.params.arguments as Record<string, unknown>) || {};
  try {
    // Data tools — pure network (no browser, no login, no lock dependency).
    if (name === 'tv_read_shared_watchlist') {
      const url = String(args.url || '');
      if (!url) return errText('provide a shared watchlist url');
      const symbols = await fetchSharedWatchlist(url);
      return text(JSON.stringify({ url, count: symbols.length, symbols }));
    }
    // No login: public symbol-search endpoint, so it sits above the ensureReady gate.
    if (name === 'tv_symbol_search') {
      const query = String(args.query || '').trim();
      if (!query) return errText('query is required');
      const limit = Number(args.limit) > 0 ? Number(args.limit) : 10;
      const results = (await searchSymbol(query)).slice(0, limit);
      return text(JSON.stringify({ query, count: results.length, results }));
    }

    if (name === 'tv_screener') {
      const out = await screener({
        filters: (args.filters as { field: string; op: string; value: number | number[] }[]) || [],
        market: args.market as string | undefined,
        sort: args.sort as { field: string; order: 'asc' | 'desc' } | undefined,
        limit: args.limit as number | undefined,
      });
      return text(JSON.stringify(out));
    }
    if (name === 'tv_watchlist_data') {
      // 1) Resolve the raw symbol list from exactly one source.
      let raw: string[] = [];
      if (Array.isArray(args.symbols) && args.symbols.length) {
        raw = (args.symbols as string[]).map(String);
      } else if (args.sheet) {
        raw = await fetchSheetSymbols(String(args.sheet), args.tab ? String(args.tab) : undefined);
      } else if (args.watchlist) {
        const page = await getPage();
        if (!(await ensureReady(page))) {
          return errText('Not logged into TradingView. Run `npm run login` once.');
        }
        const found = await openWatchlist(page, String(args.watchlist), false);
        if (!found) return errText(`watchlist not found: ${args.watchlist}`);
        raw = await readCurrentSymbols(page, true); // full = exchange-qualified
      } else {
        return errText('provide one of: symbols, sheet, or watchlist');
      }
      if (!raw.length) return errText('no symbols resolved from the given source');

      // 2) Qualify bare tickers (scanner drops unqualified ones).
      const tickers = await qualifySymbols(raw);
      if (!tickers.length) return errText('no symbols could be qualified to EXCHANGE:SYMBOL');

      // 3) One scan call for the whole list.
      const inds = Array.isArray(args.indicators) ? (args.indicators as string[]) : [];
      const tfs = Array.isArray(args.timeframes) ? (args.timeframes as string[]) : [];
      const columns = inds.length ? buildIndicatorColumns(inds, tfs.length ? tfs : ['1d']) : QUOTE_COLUMNS;
      const mkt = (args.market as string) || inferMarket(tickers[0]);
      const json = await scan(mkt, { symbols: { tickers }, columns });
      const rows = parseScanResponse(json, columns);
      return text(JSON.stringify({ count: rows.length, requested: raw.length, rows }));
    }

    const page = await getPage();

    if (name === 'tv_session_status') {
      readyPage = null;                 // force a fresh nav + check
      const loggedIn = await ensureReady(page);
      return text(JSON.stringify({ loggedIn, profileDir: PROFILE_DIR }));
    }

    if (!(await ensureReady(page))) {
      return errText('Not logged into TradingView. Run `npm run login` in the tradingview-mcp repo once.');
    }

    if (name === 'tv_list_alerts') {
      const alerts = await listAlerts(page);
      return text(JSON.stringify({ count: alerts.length, alerts }));
    }

    if (name === 'tv_delete_alert') {
      const needle = String(args.description_contains || '').trim();
      // Guard the blast radius: a one-character needle would match most of the panel.
      if (needle.length < 2) return errText('description_contains must be at least 2 characters');
      const out = await deleteAlerts(page, needle);
      return text(JSON.stringify(out));
    }

    if (name === 'tv_create_alert') {
      const raw = String(args.symbol || '').trim();
      const price = Number(args.price);
      if (!raw) return errText('symbol is required');
      if (!Number.isFinite(price) || price <= 0) return errText('price must be a positive number');
      const condition = (args.condition as ConditionKey) || 'crossing_down';
      if (!(condition in CONDITIONS)) return errText(`unknown condition: ${condition}`);

      // Qualify first. TradingView answers an unqualified or wrong-exchange symbol with
      // "Can't create alert on invalid symbol" — a modal, not an error we could read back.
      const [qualified] = raw.includes(':') ? [raw] : await qualifySymbols([raw]);
      if (!qualified) return errText(`could not qualify symbol: ${raw}`);

      const result = await createAlert(page, {
        symbol: qualified,
        price,
        condition,
        ...(args.message ? { message: String(args.message) } : {}),
      });
      // A refusal is data, not a transport failure — the caller decides what to do with it.
      return text(JSON.stringify({ symbol: qualified, ...result }));
    }

    if (name === 'tv_screenshot') {
      const symbol = String(args.symbol || '').trim();
      if (!symbol) return errText('symbol is required');
      const intervals: (string | null)[] = Array.isArray(args.intervals) && (args.intervals as string[]).length
        ? (args.intervals as string[]).slice(0, 4)
        : [args.interval ? String(args.interval) : null];
      const content: Array<{ type: string; data?: string; mimeType?: string; text?: string }> = [];
      for (const iv of intervals) {
        const out = path.join(os.tmpdir(), `tv-shot-${symbol.replace(/[^a-zA-Z0-9]/g, '_')}-${iv ? iv.replace(/[^a-zA-Z0-9]/g, '') : 'def'}-${Date.now()}.png`);
        try {
          await captureChart(page, symbol, iv, out);
          const data = fs.readFileSync(out).toString('base64');
          fs.unlink(out, () => {});
          content.push({ type: 'image', data, mimeType: 'image/png' });
          content.push({ type: 'text', text: `TradingView ${symbol} @ ${iv || 'default'}` });
        } catch (e) {
          content.push({ type: 'text', text: `[warning] screenshot failed for ${symbol} @ ${iv || 'default'}: ${(e as Error).message}` });
        }
      }
      if (!content.some((c) => c.type === 'image')) return errText('no readable screenshots produced');
      return { content };
    }

    if (name === 'tv_read_watchlist') {
      const found = await openWatchlist(page, String(args.watchlist), false);
      if (!found) return errText(`watchlist not found: ${args.watchlist}`);
      const symbols = await readCurrentSymbols(page);
      return text(JSON.stringify({ watchlist: args.watchlist, symbols }));
    }

    if (name === 'tv_add_symbols') {
      const syms = (Array.isArray(args.symbols) ? args.symbols : [])
        .map((s) => String(s).trim().toUpperCase()).filter(Boolean);
      if (!syms.length) return errText('symbols must be a non-empty array');
      await openWatchlist(page, String(args.watchlist), true);
      const { added, failed } = await addSymbolsBulk(page, syms);
      return { isError: added.length === 0 && failed.length > 0, content: [{ type: 'text', text: JSON.stringify({ watchlist: args.watchlist, added, failed }) }] };
    }

    if (name === 'tv_remove_symbols') {
      const syms = (Array.isArray(args.symbols) ? args.symbols : [])
        .map((s) => String(s).trim().toUpperCase()).filter(Boolean);
      if (!syms.length) return errText('symbols must be a non-empty array');
      const found = await openWatchlist(page, String(args.watchlist), false);
      if (!found) return errText(`watchlist not found: ${args.watchlist}`);
      const removed: string[] = [], notFound: string[] = [];
      for (const s of syms) (await removeSymbol(page, s)) ? removed.push(s) : notFound.push(s);
      return { isError: removed.length === 0 && notFound.length > 0, content: [{ type: 'text', text: JSON.stringify({ watchlist: args.watchlist, removed, notFound }) }] };
    }

    return errText(`Unknown tool: ${name}`);
  } catch (e) {
    return errText(`${name} failed: ${(e as Error).message}`);
  }
  })
);

(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
})().catch((e) => {
  process.stderr.write(`tradingview-mcp failed to start: ${(e as Error).message}\n`);
  process.exit(1);
});
