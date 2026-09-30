import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampBarCount, parseStudyValue, normalizeBars, summarizeBars, toStudyReadings, isIntraday, chartWarnings,
  DEFAULT_BAR_COUNT, MAX_BAR_COUNT,
} from '../src/chart-data';

describe('parseStudyValue', () => {
  it('parses a plain decimal', () => {
    assert.equal(parseStudyValue('52.81'), 52.81);
  });

  it('reads the Unicode minus the data window renders (Williams %R)', () => {
    assert.equal(parseStudyValue('−82.87'), -82.87);
  });

  it('expands K/M/B suffixes, as the Volume study shows them', () => {
    assert.equal(parseStudyValue('16.87 M'), 16870000);
    assert.equal(parseStudyValue('1.2K'), 1200);
    assert.equal(parseStudyValue('3.4 B'), 3400000000);
  });

  it('drops thousands separators', () => {
    assert.equal(parseStudyValue('1,234.5'), 1234.5);
  });

  it('passes non-numeric text through unchanged', () => {
    assert.equal(parseStudyValue('Bias Long'), 'Bias Long');
    assert.equal(parseStudyValue('12.5%'), '12.5%');
  });
});

describe('clampBarCount', () => {
  it('defaults when missing or not a positive number', () => {
    assert.equal(clampBarCount(undefined), DEFAULT_BAR_COUNT);
    assert.equal(clampBarCount(NaN), DEFAULT_BAR_COUNT);
    assert.equal(clampBarCount(0), DEFAULT_BAR_COUNT);
  });

  it('caps at what the chart loads, and floors fractions', () => {
    assert.equal(clampBarCount(5000), MAX_BAR_COUNT);
    assert.equal(clampBarCount(20.7), 20);
  });
});

describe('normalizeBars', () => {
  it('maps [time, o, h, l, c, v] rows to named fields', () => {
    assert.deepEqual(normalizeBars([[1790688600, 336.965, 337.085, 330.55, 331.26, 16868779]]), [
      { time: 1790688600, open: 336.965, high: 337.085, low: 330.55, close: 331.26, volume: 16868779 },
    ]);
  });

  it('drops a row with a missing price instead of reading null as 0', () => {
    assert.equal(normalizeBars([[1, 10, 11, 9, null, 100]]).length, 0);
  });

  it('keeps a bar with no volume, as 0', () => {
    assert.equal(normalizeBars([[1, 10, 11, 9, 10.5]])[0].volume, 0);
  });
});

describe('summarizeBars', () => {
  const bars = [
    { time: 1, open: 100, high: 105, low: 98, close: 104, volume: 1000 },
    { time: 2, open: 104, high: 112, low: 103, close: 110, volume: 3000 },
    { time: 3, open: 110, high: 111, low: 95, close: 99, volume: 2000 },
  ];

  it('spans the range from first open to last close', () => {
    const s = summarizeBars(bars);
    assert.ok(s);
    assert.equal(s.from, 1);
    assert.equal(s.to, 3);
    assert.equal(s.high, 112);
    assert.equal(s.low, 95);
    assert.equal(s.changePct, -1);
    assert.equal(s.avgVolume, 2000);
  });

  it('returns undefined for no bars', () => {
    assert.equal(summarizeBars([]), undefined);
  });
});

describe('toStudyReadings', () => {
  it('parses values and drops studies that show nothing (Dividends, Splits)', () => {
    const out = toStudyReadings([
      { name: 'Relative Strength Index', items: [['RSI', '52.81'], ['RSI-based MA', '62.56']] },
      { name: 'Dividends', items: [] },
    ]);
    assert.deepEqual(out, [{ name: 'Relative Strength Index', values: { RSI: 52.81, 'RSI-based MA': 62.56 } }]);
  });
});

describe('isIntraday', () => {
  it('treats minute and second codes as intraday', () => {
    assert.equal(isIntraday('60'), true);
    assert.equal(isIntraday('15'), true);
    assert.equal(isIntraday('1S'), true);
  });

  it('treats day, week and month as not intraday', () => {
    for (const iv of ['D', '1D', 'W', 'M']) assert.equal(isIntraday(iv), false, iv);
  });
});

describe('chartWarnings', () => {
  it('says nothing when the chart loaded the requested venue', () => {
    assert.deepEqual(chartWarnings('NASDAQ:AAPL', 'NASDAQ:AAPL', '60'), []);
  });

  it('flags a substitute venue on a daily chart, without a volume warning', () => {
    const w = chartWarnings('NASDAQ:AAPL', 'BATS:AAPL', 'D');
    assert.equal(w.length, 1);
    assert.match(w[0], /BATS:AAPL instead of NASDAQ:AAPL/);
  });

  it('adds the single-venue volume warning on an intraday substitute', () => {
    const w = chartWarnings('NYSE:ORA', 'BATS:ORA', '60');
    assert.equal(w.length, 2);
    assert.match(w[1], /BATS-only/);
  });

  it('cannot judge a bare ticker, so stays silent', () => {
    assert.deepEqual(chartWarnings('AAPL', 'BATS:AAPL', '60'), []);
  });
});
