import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inferMarket, normalizeOp,
  resolveColumn, tfSuffix, buildIndicatorColumns, parseScanResponse,
  buildQuoteBody, QUOTE_COLUMNS,
  buildScreenerBody,
  parseSearchResults,
  sheetIdFromInput, parseSheetCsv, sheetCsvUrl,
  qualifySymbols,
} from '../src/scanner';

test('sheetCsvUrl without tab uses the first-sheet export endpoint', () => {
  assert.equal(
    sheetCsvUrl('ABC123'),
    'https://docs.google.com/spreadsheets/d/ABC123/export?format=csv'
  );
});

test('sheetCsvUrl with tab uses the gviz endpoint with the encoded sheet name', () => {
  assert.equal(
    sheetCsvUrl('ABC123', 'Big Tech'),
    'https://docs.google.com/spreadsheets/d/ABC123/gviz/tq?tqx=out:csv&sheet=Big%20Tech'
  );
});

test('inferMarket maps known exchange prefixes', () => {
  assert.equal(inferMarket('NASDAQ:AAPL'), 'america');
  assert.equal(inferMarket('NYSE:T'), 'america');
  assert.equal(inferMarket('AMEX:SPY'), 'america');
  assert.equal(inferMarket('BINANCE:BTCUSDT'), 'crypto');
  assert.equal(inferMarket('COINBASE:ETHUSD'), 'crypto');
});

test('inferMarket falls back to america for bare/unknown symbols', () => {
  assert.equal(inferMarket('AAPL'), 'america');
  assert.equal(inferMarket('WEIRD:THING'), 'america');
});

test('normalizeOp maps friendly operators to TV operations', () => {
  assert.equal(normalizeOp('gt'), 'greater');
  assert.equal(normalizeOp('greater'), 'greater');
  assert.equal(normalizeOp('lt'), 'less');
  assert.equal(normalizeOp('gte'), 'egreater');
  assert.equal(normalizeOp('lte'), 'eless');
  assert.equal(normalizeOp('eq'), 'equal');
  assert.equal(normalizeOp('between'), 'in_range');
});

test('normalizeOp throws on unknown operator', () => {
  assert.throws(() => normalizeOp('explode'), /unknown operator/i);
});

// Task 2

test('resolveColumn maps friendly indicator names to TV columns', () => {
  assert.equal(resolveColumn('rsi'), 'RSI');
  assert.equal(resolveColumn('macd'), 'MACD.macd');
  assert.equal(resolveColumn('rvol'), 'relative_volume_10d_calc');
  assert.equal(resolveColumn('bb_upper'), 'BB.upper');
  assert.equal(resolveColumn('sma50'), 'SMA50');
  assert.equal(resolveColumn('recommend'), 'Recommend.All');
});

test('resolveColumn passes through already-valid TV columns', () => {
  assert.equal(resolveColumn('Recommend.All'), 'Recommend.All');
  assert.equal(resolveColumn('close'), 'close');
});

test('tfSuffix returns empty for daily and a |code for intraday/higher', () => {
  assert.equal(tfSuffix('1d'), '');
  assert.equal(tfSuffix('daily'), '');
  assert.equal(tfSuffix('1h'), '|60');
  assert.equal(tfSuffix('15m'), '|15');
  assert.equal(tfSuffix('4h'), '|240');
  assert.equal(tfSuffix('1w'), '|1W');
});

test('buildIndicatorColumns crosses indicators with timeframes', () => {
  assert.deepEqual(
    buildIndicatorColumns(['rsi', 'macd'], ['1d', '1h']),
    ['RSI', 'MACD.macd', 'RSI|60', 'MACD.macd|60']
  );
});

test('parseScanResponse zips columns with row values into objects', () => {
  const json = { totalCount: 1, data: [{ s: 'NASDAQ:AAPL', d: [298.01, 50.9] }] };
  assert.deepEqual(parseScanResponse(json, ['close', 'RSI']), [
    { symbol: 'NASDAQ:AAPL', close: 298.01, RSI: 50.9 },
  ]);
});

test('parseScanResponse tolerates empty/missing data', () => {
  assert.deepEqual(parseScanResponse({ totalCount: 0, data: [] }, ['close']), []);
  assert.deepEqual(parseScanResponse({}, ['close']), []);
});

test('parseScanResponse yields nulls when a row has no values', () => {
  const json = { totalCount: 1, data: [{ s: 'X:Y', d: null }] };
  assert.deepEqual(parseScanResponse(json, ['close', 'RSI']), [
    { symbol: 'X:Y', close: null, RSI: null },
  ]);
});

// Task 3

test('buildQuoteBody normalizes tickers and uses default columns', () => {
  const body = buildQuoteBody(['nasdaq:aapl', 'NVDA']);
  assert.deepEqual(body.symbols.tickers, ['NASDAQ:AAPL', 'NVDA']);
  assert.deepEqual(body.columns, QUOTE_COLUMNS);
});

test('QUOTE_COLUMNS includes RVOL (the radar core metric)', () => {
  assert.ok(QUOTE_COLUMNS.includes('relative_volume_10d_calc'));
});

// Task 4

test('buildScreenerBody maps friendly filters and defaults', () => {
  const body = buildScreenerBody({
    filters: [
      { field: 'rvol', op: 'gt', value: 2 },
      { field: 'rsi', op: 'lt', value: 30 },
    ],
  });
  assert.deepEqual(body.filter, [
    { left: 'relative_volume_10d_calc', operation: 'greater', right: 2 },
    { left: 'RSI', operation: 'less', right: 30 },
  ]);
  assert.deepEqual(body.range, [0, 30]); // default limit
  assert.equal(body.sort.sortBy, 'volume'); // default sort
  assert.equal(body.sort.sortOrder, 'desc');
  assert.ok(body.columns.includes('name'));
});

test('buildScreenerBody honors custom sort, limit, and between-ranges', () => {
  const body = buildScreenerBody({
    filters: [{ field: 'rsi', op: 'between', value: [40, 60] }],
    sort: { field: 'rvol', order: 'asc' },
    limit: 5,
  });
  assert.deepEqual(body.filter[0], { left: 'RSI', operation: 'in_range', right: [40, 60] });
  assert.deepEqual(body.range, [0, 5]);
  assert.equal(body.sort.sortBy, 'relative_volume_10d_calc');
  assert.equal(body.sort.sortOrder, 'asc');
});

test('buildScreenerBody caps limit at 100', () => {
  const body = buildScreenerBody({ filters: [], limit: 9999 });
  assert.deepEqual(body.range, [0, 100]);
});

// Task 5

test('parseSearchResults strips <em> tags and keeps key fields', () => {
  const raw = [
    { symbol: 'AAPL', description: '<em>Apple</em> Inc.', type: 'stock',
      exchange: 'NASDAQ', currency_code: 'USD', country: 'US' },
  ];
  assert.deepEqual(parseSearchResults(raw), [
    { symbol: 'AAPL', tvSymbol: 'NASDAQ:AAPL', description: 'Apple Inc.',
      type: 'stock', exchange: 'NASDAQ', currency: 'USD', country: 'US' },
  ]);
});

test('parseSearchResults strips <em> from the symbol field (hl=1 ticker highlight)', () => {
  const raw = [
    { symbol: '<em>AAPL</em>', description: '<em>Apple</em> Inc.', type: 'stock',
      exchange: 'NASDAQ', currency_code: 'USD', country: 'US' },
  ];
  assert.deepEqual(parseSearchResults(raw), [
    { symbol: 'AAPL', tvSymbol: 'NASDAQ:AAPL', description: 'Apple Inc.',
      type: 'stock', exchange: 'NASDAQ', currency: 'USD', country: 'US' },
  ]);
});

test('parseSearchResults tolerates missing fields and non-arrays', () => {
  assert.deepEqual(parseSearchResults([{ symbol: 'X' }]), [
    { symbol: 'X', tvSymbol: 'X', description: '', type: '', exchange: '',
      currency: '', country: '' },
  ]);
  assert.deepEqual(parseSearchResults(null), []);
});

// Task 8

test('sheetIdFromInput extracts the id from a full URL or passes an id through', () => {
  assert.equal(
    sheetIdFromInput('https://docs.google.com/spreadsheets/d/1AbcDEF_ghi-JKL2345678901234567890/edit#gid=0'),
    '1AbcDEF_ghi-JKL2345678901234567890'
  );
  assert.equal(sheetIdFromInput('1AbcDEF_ghi-JKL2345678901234567890'), '1AbcDEF_ghi-JKL2345678901234567890');
});

test('parseSheetCsv takes column A, skips a header row and blanks', () => {
  const csv = 'Symbol,Sector\nAAPL,Tech\nNVDA,Tech\n\nMETA,Comm';
  assert.deepEqual(parseSheetCsv(csv), ['AAPL', 'NVDA', 'META']);
});

test('parseSheetCsv keeps first row when it is not a header', () => {
  assert.deepEqual(parseSheetCsv('AAPL\nNVDA'), ['AAPL', 'NVDA']);
});

// Task 9

test('qualifySymbols leaves already-qualified symbols untouched', async () => {
  const resolver = async () => { throw new Error('should not be called'); };
  assert.deepEqual(await qualifySymbols(['NASDAQ:AAPL', 'BINANCE:BTCUSDT'], resolver), [
    'NASDAQ:AAPL', 'BINANCE:BTCUSDT',
  ]);
});

test('qualifySymbols resolves bare tickers via the resolver', async () => {
  const resolver = async (q: string) =>
    q === 'AAPL' ? [{ tvSymbol: 'NASDAQ:AAPL' } as any] : [];
  assert.deepEqual(await qualifySymbols(['AAPL', 'NYSE:T'], resolver), ['NASDAQ:AAPL', 'NYSE:T']);
});

test('qualifySymbols drops bare tickers that cannot be resolved', async () => {
  const resolver = async () => [];
  assert.deepEqual(await qualifySymbols(['ZZZNOPE'], resolver), []);
});

test('parseSearchResults prefers prefix over the display exchange name', () => {
  // Euronext returns exchange="Euronext Amsterdam" (a label, with a space) and
  // prefix="EURONEXT" (the routing code). Only the latter resolves on TradingView.
  const [r] = parseSearchResults([
    { symbol: 'THEON', exchange: 'Euronext Amsterdam', prefix: 'EURONEXT', country: 'NL', currency_code: 'EUR' },
  ]);
  assert.equal(r.tvSymbol, 'EURONEXT:THEON');
  assert.equal(r.exchange, 'Euronext Amsterdam');
});

test('parseSearchResults falls back to exchange when there is no prefix', () => {
  const [r] = parseSearchResults([{ symbol: 'ONTO', exchange: 'NYSE', country: 'US' }]);
  assert.equal(r.tvSymbol, 'NYSE:ONTO');
});

test('parseSearchResults keeps currency so callers can disambiguate a shared ticker', () => {
  // "ORA" is Orange (FR/EUR) on Euronext and Ormat (US/USD) on NYSE. Ranking alone picks
  // the wrong one; the currency is what tells them apart.
  const rows = parseSearchResults([
    { symbol: 'ORA', exchange: 'Euronext Paris', prefix: 'EURONEXT', country: 'FR', currency_code: 'EUR' },
    { symbol: 'ORA', exchange: 'NYSE', country: 'US', currency_code: 'USD' },
  ]);
  assert.equal(rows[0].tvSymbol, 'EURONEXT:ORA');
  assert.equal(rows.find((r) => r.currency === 'USD')?.tvSymbol, 'NYSE:ORA');
});
