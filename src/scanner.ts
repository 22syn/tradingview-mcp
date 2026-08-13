// Pure data layer for TradingView's public endpoints. No Playwright, no login.

const CRYPTO_EXCHANGES = new Set([
  'BINANCE', 'COINBASE', 'KUCOIN', 'BYBIT', 'OKX', 'KRAKEN', 'BITSTAMP', 'BITFINEX',
]);

/** Infer the scanner market path from a symbol's exchange prefix. */
export function inferMarket(symbol: string): string {
  const prefix = symbol.includes(':') ? symbol.split(':')[0].toUpperCase() : '';
  if (CRYPTO_EXCHANGES.has(prefix)) return 'crypto';
  return 'america';
}

const OP_MAP: Record<string, string> = {
  gt: 'greater', greater: 'greater',
  lt: 'less', less: 'less',
  gte: 'egreater', egreater: 'egreater',
  lte: 'eless', eless: 'eless',
  eq: 'equal', equal: 'equal',
  between: 'in_range', in_range: 'in_range',
};

/** Map a friendly comparison operator to a TradingView scanner operation. */
export function normalizeOp(op: string): string {
  const tv = OP_MAP[op.trim().toLowerCase()];
  if (!tv) throw new Error(`unknown operator: ${op}`);
  return tv;
}

const COLUMN_ALIASES: Record<string, string> = {
  rsi: 'RSI',
  macd: 'MACD.macd', macd_signal: 'MACD.signal',
  sma20: 'SMA20', sma50: 'SMA50', sma200: 'SMA200', ema20: 'EMA20',
  bb_upper: 'BB.upper', bb_lower: 'BB.lower',
  rvol: 'relative_volume_10d_calc', avg_volume: 'average_volume_10d_calc',
  recommend: 'Recommend.All',
  close: 'close', change: 'change', volume: 'volume', name: 'name',
};

/** Map a friendly indicator/column name to a TV column; pass through if already valid. */
export function resolveColumn(name: string): string {
  return COLUMN_ALIASES[name.trim().toLowerCase()] ?? name;
}

const TF_SUFFIX: Record<string, string> = {
  '1m': '|1', '1': '|1',
  '5m': '|5', '5': '|5',
  '15m': '|15', '15': '|15',
  '30m': '|30', '30': '|30',
  '1h': '|60', '60': '|60',
  '2h': '|120', '120': '|120',
  '4h': '|240', '240': '|240',
  '1d': '', d: '', daily: '',
  '1w': '|1W', w: '|1W', weekly: '|1W',
  '1mo': '|1M', monthly: '|1M',
};

/** TradingView column suffix for a timeframe ('' = daily, the endpoint default). */
export function tfSuffix(tf: string): string {
  const key = tf.trim().toLowerCase();
  if (!(key in TF_SUFFIX)) throw new Error(`unknown timeframe: ${tf}`);
  return TF_SUFFIX[key];
}

/** Cross a list of indicators with a list of timeframes into TV column names. */
export function buildIndicatorColumns(indicators: string[], timeframes: string[]): string[] {
  const cols: string[] = [];
  for (const tf of timeframes) {
    const suffix = tfSuffix(tf);
    for (const ind of indicators) cols.push(resolveColumn(ind) + suffix);
  }
  return cols;
}

export interface ScanRow {
  symbol: string;
  [column: string]: string | number | null;
}

/** Zip the response's column-ordered value arrays back into named objects. */
export function parseScanResponse(json: unknown, columns: string[]): ScanRow[] {
  const data = (json as { data?: Array<{ s: string; d: unknown[] }> })?.data;
  if (!Array.isArray(data)) return [];
  return data.map((row) => {
    const obj: ScanRow = { symbol: row.s };
    columns.forEach((col, i) => {
      obj[col] = (row.d?.[i] ?? null) as string | number | null;
    });
    return obj;
  });
}

// ---------------------------------------------------------------------------
// Task 3: Network core — scan() + quote()
// ---------------------------------------------------------------------------

const SCAN_BASE = 'https://scanner.tradingview.com';

/** Low-level POST to the scanner. Returns parsed JSON or throws on HTTP error. */
export async function scan(market: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${SCAN_BASE}/${market}/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`scanner HTTP ${res.status} for market "${market}"`);
  return res.json();
}

export const QUOTE_COLUMNS = [
  'name', 'close', 'change', 'volume',
  'relative_volume_10d_calc', 'average_volume_10d_calc',
  'RSI', 'Recommend.All',
];

export interface QuoteBody {
  symbols: { tickers: string[] };
  columns: string[];
}

/** Build the scan request body for a multi-symbol quote. */
export function buildQuoteBody(symbols: string[], columns: string[] = QUOTE_COLUMNS): QuoteBody {
  return {
    symbols: { tickers: symbols.map((s) => s.trim().toUpperCase()) },
    columns,
  };
}

/** Snapshot one or more symbols. Market inferred from the first symbol unless given. */
export async function quote(symbols: string[], market?: string): Promise<ScanRow[]> {
  if (symbols.length === 0) return [];
  const mkt = market ?? inferMarket(symbols[0]);
  const body = buildQuoteBody(symbols);
  const json = await scan(mkt, body);
  return parseScanResponse(json, body.columns);
}

// ---------------------------------------------------------------------------
// Task 4: screener()
// ---------------------------------------------------------------------------

export interface ScreenerFilter {
  field: string;
  op: string;
  value: number | number[];
}
export interface ScreenerOptions {
  filters: ScreenerFilter[];
  market?: string;
  sort?: { field: string; order: 'asc' | 'desc' };
  columns?: string[];
  limit?: number;
}

export const SCREENER_COLUMNS = [
  'name', 'close', 'change', 'volume', 'relative_volume_10d_calc', 'RSI',
];

export interface ScreenerBody {
  filter: Array<{ left: string; operation: string; right: number | number[] }>;
  options: { lang: string };
  sort: { sortBy: string; sortOrder: 'asc' | 'desc' };
  range: [number, number];
  columns: string[];
}

/** Build the scan request body for a market screener. */
export function buildScreenerBody(opts: ScreenerOptions): ScreenerBody {
  // clamp to [1,100]: scanner rejects huge ranges, and limit 0 would return no rows
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const sortField = opts.sort?.field ? resolveColumn(opts.sort.field) : 'volume';
  return {
    filter: opts.filters.map((f) => ({
      left: resolveColumn(f.field),
      operation: normalizeOp(f.op),
      right: f.value,
    })),
    options: { lang: 'en' },
    sort: { sortBy: sortField, sortOrder: opts.sort?.order ?? 'desc' },
    range: [0, limit],
    columns: opts.columns ?? SCREENER_COLUMNS,
  };
}

/** Run a market screener. Returns { totalCount, rows }. */
export async function screener(
  opts: ScreenerOptions
): Promise<{ totalCount: number; rows: ScanRow[] }> {
  const body = buildScreenerBody(opts);
  const json = await scan(opts.market ?? 'america', body);
  const totalCount = (json as { totalCount?: number })?.totalCount ?? 0;
  return { totalCount, rows: parseScanResponse(json, body.columns) };
}

// ---------------------------------------------------------------------------
// Task 5: indicators() + searchSymbol()
// ---------------------------------------------------------------------------

/** Per-symbol indicator matrix across timeframes. Columns named like RSI|60. */
export async function indicators(
  symbol: string,
  inds: string[],
  timeframes: string[],
  market?: string
): Promise<ScanRow | null> {
  const columns = buildIndicatorColumns(inds, timeframes);
  const body = { symbols: { tickers: [symbol.trim().toUpperCase()] }, columns };
  const json = await scan(market ?? inferMarket(symbol), body);
  const rows = parseScanResponse(json, columns);
  return rows[0] ?? null;
}

const SEARCH_BASE = 'https://symbol-search.tradingview.com/symbol_search/';

export interface SearchResult {
  symbol: string;
  tvSymbol: string;
  description: string;
  type: string;
  exchange: string;
  currency: string;
  country: string;
}

/**
 * Normalize raw symbol-search JSON: strip <em> tags, build EXCHANGE:SYMBOL.
 *
 * `prefix` wins over `exchange` when the API supplies it. For Euronext listings the search
 * returns exchange="Euronext Amsterdam" — a display name, with a space — alongside
 * prefix="EURONEXT", which is the routing code TradingView actually accepts. Building from
 * `exchange` alone produced "Euronext Amsterdam:THEON", which no chart or alert resolves.
 */
export function parseSearchResults(raw: unknown): SearchResult[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r: Record<string, unknown>) => {
    const symbol = String(r.symbol ?? '').replace(/<\/?em>/g, '');
    const exchange = String(r.exchange ?? '');
    const route = String(r.prefix ?? '') || exchange;
    return {
      symbol,
      tvSymbol: route ? `${route}:${symbol}` : symbol,
      description: String(r.description ?? '').replace(/<\/?em>/g, ''),
      type: String(r.type ?? ''),
      exchange,
      currency: String(r.currency_code ?? ''),
      country: String(r.country ?? ''),
    };
  });
}

/** Resolve a free-text query to candidate TradingView symbols. */
export async function searchSymbol(query: string): Promise<SearchResult[]> {
  const url = `${SEARCH_BASE}?text=${encodeURIComponent(query)}&hl=1&lang=en&domain=production`;
  const res = await fetch(url, {
    headers: {
      Origin: 'https://www.tradingview.com',
      Referer: 'https://www.tradingview.com/',
    },
  });
  if (!res.ok) throw new Error(`symbol-search HTTP ${res.status}`);
  return parseSearchResults(await res.json());
}

// ---------------------------------------------------------------------------
// Task 8: Google Sheet CSV source
// ---------------------------------------------------------------------------

/** Build the public CSV URL for a sheet; with `tab`, target that tab by name via gviz. */
export function sheetCsvUrl(id: string, tab?: string): string {
  if (tab && tab.trim()) {
    return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
  }
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
}

/** Accept a raw sheet id or any Google Sheets URL; return the id. */
export function sheetIdFromInput(input: string): string {
  const m = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,60})/);
  return m ? m[1] : input.trim();
}

/** Parse CSV → first-column symbols, skipping a header row and blank lines. */
export function parseSheetCsv(csv: string): string[] {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const cells = lines.map((l) => l.split(',')[0].replace(/^"|"$/g, '').trim());
  if (cells.length && /^symbol$/i.test(cells[0])) cells.shift(); // drop header
  return cells.filter(Boolean);
}

/** Fetch a public Google Sheet's first column as a symbol list (optionally a named tab). */
export async function fetchSheetSymbols(input: string, tab?: string): Promise<string[]> {
  const id = sheetIdFromInput(input);
  const res = await fetch(sheetCsvUrl(id, tab));
  if (!res.ok) {
    throw new Error(
      `sheet fetch HTTP ${res.status} — check the id/tab and that the sheet is shared "Anyone with the link can view"`
    );
  }
  return parseSheetCsv(await res.text());
}

// ---------------------------------------------------------------------------
// Task 9: qualifySymbols()
// ---------------------------------------------------------------------------

type Resolver = (q: string) => Promise<SearchResult[]>;

/** Ensure every symbol is EXCHANGE:SYMBOL. Bare ones are resolved via `resolver`
 *  (defaults to searchSymbol); unresolvable bare symbols are dropped. */
export async function qualifySymbols(
  symbols: string[],
  resolver: Resolver = searchSymbol
): Promise<string[]> {
  const results = await Promise.all(
    symbols.map(async (s) => {
      const sym = s.trim();
      if (sym.includes(':')) return sym.toUpperCase();
      const hits = await resolver(sym);
      return hits[0]?.tvSymbol ?? null;
    })
  );
  return results.filter((s): s is string => s !== null);
}
