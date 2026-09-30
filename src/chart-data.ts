import type { Page } from 'playwright';
import { tvInterval } from './driver';

// Reads bars and indicator values from the chart's internal model — the same objects
// tradesdontlie/tradingview-mcp reads over CDP from TradingView Desktop. The web chart
// exposes them on window.TradingViewApi. They are undocumented and can move on any
// TradingView release: if reads start failing, check the path chain in readChartModel first.

export const DEFAULT_BAR_COUNT = 100;
// What the chart loads without scrolling back in time.
export const MAX_BAR_COUNT = 300;
const LOAD_TIMEOUT_MS = 30000;
const STUDY_POLL_MS = 400;
// Three equal readings in a row: pane studies (RSI, %R) fill in after the main series.
const STUDY_STABLE_REPEATS = 2;
const STUDY_MAX_WAIT_MS = 8000;
const VALUE_SUFFIXES: Readonly<Record<string, number>> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BarSummary {
  from: number;
  to: number;
  open: number;
  close: number;
  high: number;
  low: number;
  changePct: number;
  avgVolume: number;
  last5: Bar[];
}

export interface StudyReading {
  name: string;
  values: Record<string, number | string>;
}

export interface ChartData {
  symbol: string;
  chartSymbol: string;
  interval: string;
  totalBars: number;
  bars?: Bar[];
  summary?: BarSummary;
  studies: StudyReading[];
  warnings: string[];
}

export interface ChartDataOptions {
  symbol: string;
  interval?: string;
  count?: number;
  summary?: boolean;
}

interface RawStudy {
  name: string;
  items: [string, string][];
}

interface RawChartModel {
  chartSymbol: string;
  resolution: string;
  totalBars: number;
  bars: unknown[][];
  studies: RawStudy[];
}

// Minimal shape of the undocumented globals we touch — only what readChartModel calls.
interface TvSeriesBars {
  size(): number;
  firstIndex(): number;
  lastIndex(): number;
  valueAt(i: number): unknown[] | null;
}
interface TvDataSource {
  metaInfo?(): { description?: string; shortDescription?: string };
  dataWindowView?(): { items(): { _title?: string; _value?: string }[] | null } | null;
}
interface TvWindow {
  TradingViewApi: {
    _activeChartWidgetWV: { value(): { _chartWidget: { model(): {
      mainSeries(): { bars(): TvSeriesBars };
      model(): { dataSources(): TvDataSource[] };
    } } } };
    activeChart(): { symbol(): string; resolution(): string };
  };
}

export function clampBarCount(n?: number): number {
  if (n === undefined || !Number.isFinite(n) || n < 1) return DEFAULT_BAR_COUNT;
  return Math.min(Math.floor(n), MAX_BAR_COUNT);
}

/** Parse a data-window display string ("−82.87", "16.87 M", "1,234.5") into a number; other text passes through. */
export function parseStudyValue(raw: string): number | string {
  const s = raw.replace(/−/g, '-').replace(/,/g, '').trim();
  const m = /^(-?\d+(?:\.\d+)?)\s*([KMBT])?$/i.exec(s);
  if (!m) return raw;
  const n = Number(m[1]);
  return m[2] ? Math.round(n * VALUE_SUFFIXES[m[2].toUpperCase()]) : n;
}

function finiteOrNaN(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : NaN;
}

/** Map raw [time, o, h, l, c, v] rows to bars, dropping rows with a missing price. */
export function normalizeBars(rows: readonly unknown[][]): Bar[] {
  const bars: Bar[] = [];
  for (const row of rows) {
    const [time, open, high, low, close, volume] = row.map(finiteOrNaN);
    if (![time, open, high, low, close].every(Number.isFinite)) continue;
    bars.push({ time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
  }
  return bars;
}

export function summarizeBars(bars: readonly Bar[]): BarSummary | undefined {
  if (!bars.length) return undefined;
  const first = bars[0];
  const last = bars[bars.length - 1];
  let high = -Infinity;
  let low = Infinity;
  let volume = 0;
  for (const b of bars) {
    high = Math.max(high, b.high);
    low = Math.min(low, b.low);
    volume += b.volume;
  }
  return {
    from: first.time, to: last.time, open: first.open, close: last.close, high, low,
    changePct: Math.round(((last.close - first.open) / first.open) * 10000) / 100,
    avgVolume: Math.round(volume / bars.length),
    last5: bars.slice(-5),
  };
}

/** Keep studies that show at least one value, parsed to numbers where possible. */
export function toStudyReadings(raw: readonly RawStudy[]): StudyReading[] {
  const out: StudyReading[] = [];
  for (const s of raw) {
    const values: Record<string, number | string> = {};
    for (const [title, value] of s.items) values[title] = parseStudyValue(value);
    if (Object.keys(values).length) out.push({ name: s.name, values });
  }
  return out;
}

/** TradingView codes: digits are minutes, "S" suffix is seconds; D/W/M (optionally 1D…) are not intraday. */
export function isIntraday(interval: string): boolean {
  return /^\d+S?$/i.test(interval.trim());
}

function exchangeOf(symbol: string): string {
  return symbol.includes(':') ? symbol.split(':')[0].toUpperCase() : '';
}

/**
 * Without real-time exchange data TradingView loads a substitute venue (NASDAQ:AAPL → BATS:AAPL).
 * Measured 2026-09-29: daily volume on the substitute matched the scanner (ORA 178K vs 174K),
 * but summed intraday bars held only 4–10% of it — single-venue volume.
 */
export function chartWarnings(requested: string, chartSymbol: string, interval: string): string[] {
  const want = exchangeOf(requested);
  const got = exchangeOf(chartSymbol);
  if (!want || !got || want === got) return [];
  const warnings = [`chart loaded ${chartSymbol} instead of ${requested}: prices come from that venue and track the primary listing closely`];
  if (isIntraday(interval)) {
    warnings.push(`intraday bar volume is ${got}-only, a fraction of consolidated volume — use tv_watchlist_data for volume/RVOL`);
  }
  return warnings;
}

async function waitForChart(page: Page, symbol: string, interval: string): Promise<void> {
  const loaded = await page.waitForFunction(([sym, iv]) => {
    try {
      // Undocumented global with no published types — see TvWindow.
      const api = (window as unknown as TvWindow).TradingViewApi;
      const chart = api.activeChart();
      const want = String(sym.split(':').pop()).toUpperCase();
      const got = String(String(chart.symbol()).split(':').pop()).toUpperCase();
      const res = String(chart.resolution()).toUpperCase().replace(/^1(?=[DWM]$)/, '');
      const bars = api._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
      return got === want && res === iv && bars.size() > 0;
    } catch {
      return false;
    }
  }, [symbol, interval.toUpperCase().replace(/^1(?=[DWM]$)/, '')] as const,
  { timeout: LOAD_TIMEOUT_MS, polling: 500 }).then(() => true, () => false);
  if (loaded) return;
  const showing = await page.evaluate(() => {
    try {
      const chart = (window as unknown as TvWindow).TradingViewApi.activeChart();
      return `${chart.symbol()} @ ${chart.resolution()}`;
    } catch {
      return 'no chart API';
    }
  }).catch(() => 'page not readable');
  throw new Error(`chart did not load ${symbol} @ ${interval} within ${LOAD_TIMEOUT_MS / 1000}s (showing ${showing})`);
}

async function countFilledStudyValues(page: Page): Promise<number> {
  return page.evaluate(() => {
    let filled = 0;
    try {
      const model = (window as unknown as TvWindow).TradingViewApi._activeChartWidgetWV.value()._chartWidget.model();
      for (const s of model.model().dataSources()) {
        try {
          for (const it of s.dataWindowView?.()?.items() ?? []) if (it._value && it._value !== '∅') filled++;
        } catch { /* a source without a data window contributes nothing */ }
      }
    } catch { /* chart torn down mid-poll — report nothing filled */ }
    return filled;
  }).catch(() => -1);
}

async function waitForStudyValues(page: Page): Promise<void> {
  const deadline = Date.now() + STUDY_MAX_WAIT_MS;
  let last = -1;
  let repeats = 0;
  while (Date.now() < deadline) {
    const filled = await countFilledStudyValues(page);
    repeats = filled === last ? repeats + 1 : 0;
    last = filled;
    if (repeats >= STUDY_STABLE_REPEATS) return;
    await page.waitForTimeout(STUDY_POLL_MS);
  }
}

async function readChartModel(page: Page, count: number): Promise<RawChartModel> {
  return page.evaluate((n: number) => {
    const api = (window as unknown as TvWindow).TradingViewApi;
    const model = api._activeChartWidgetWV.value()._chartWidget.model();
    const series = model.mainSeries().bars();
    const bars: unknown[][] = [];
    for (let i = Math.max(series.firstIndex(), series.lastIndex() - n + 1); i <= series.lastIndex(); i++) {
      const v = series.valueAt(i);
      if (v) bars.push(v.slice(0, 6));
    }
    const studies: RawStudy[] = [];
    for (const s of model.model().dataSources()) {
      try {
        const meta = s.metaInfo?.();
        const name = meta?.description || meta?.shortDescription || '';
        if (!name) continue;
        const items: [string, string][] = [];
        for (const it of s.dataWindowView?.()?.items() ?? []) {
          if (it._title && it._value && it._value !== '∅') items.push([it._title, it._value]);
        }
        studies.push({ name, items });
      } catch { /* skip a source whose internals changed shape */ }
    }
    const chart = api.activeChart();
    return { chartSymbol: chart.symbol(), resolution: chart.resolution(), totalBars: series.size(), bars, studies };
  }, count);
}

/** Load a symbol on the saved layout and read its bars plus every indicator already on it. Never adds studies. */
export async function readChartData(page: Page, opts: ChartDataOptions): Promise<ChartData> {
  const interval = tvInterval(opts.interval || 'D');
  const url = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(opts.symbol)}&interval=${encodeURIComponent(interval)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await waitForChart(page, opts.symbol, interval);
  await waitForStudyValues(page);
  const raw = await readChartModel(page, clampBarCount(opts.count));
  const bars = normalizeBars(raw.bars);
  return {
    symbol: opts.symbol,
    chartSymbol: raw.chartSymbol,
    interval: raw.resolution,
    totalBars: raw.totalBars,
    ...(opts.summary ? { summary: summarizeBars(bars) } : { bars }),
    studies: toStudyReadings(raw.studies),
    warnings: chartWarnings(opts.symbol, raw.chartSymbol, interval),
  };
}
