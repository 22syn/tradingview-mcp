import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchesAlert, CONDITIONS } from '../src/alerts';

/**
 * matchesAlert is the whole idempotency guard: get it wrong in one direction and every run
 * duplicates every alert, wrong in the other and a real new level is silently skipped.
 * It is also the only part of alerts.ts testable without a browser.
 */
describe('matchesAlert', () => {
  it('matches a plain title', () => {
    assert.equal(matchesAlert('ONTO Crossing 201.75', 'ONTO', CONDITIONS.crossing, 201.75), true);
  });

  it('matches across the thousands separator TradingView adds', () => {
    // The live panel renders "Crossing 2,432"; a caller asks for 2432. These are the same
    // alert, and an exact string compare would duplicate it on every run.
    assert.equal(matchesAlert('NXSN Crossing Down 19,322', 'NXSN', CONDITIONS.crossing_down, 19322), true);
    assert.equal(matchesAlert('ARYT Crossing 2,432', 'ARYT', CONDITIONS.crossing, 2432), true);
  });

  it('does not treat Crossing Down as plain Crossing', () => {
    // "Crossing Down".includes("Crossing") is true, so a naive check conflates the two and
    // would skip creating a directional stop because an undirected alert already exists.
    assert.equal(matchesAlert('NXSN Crossing Down 19322', 'NXSN', CONDITIONS.crossing, 19322), false);
    assert.equal(matchesAlert('NXSN Crossing 19322', 'NXSN', CONDITIONS.crossing_down, 19322), false);
  });

  it('separates Crossing Up from Crossing Down', () => {
    assert.equal(matchesAlert('QBTS Crossing Up 30', 'QBTS', CONDITIONS.crossing_down, 30), false);
    assert.equal(matchesAlert('QBTS Crossing Up 30', 'QBTS', CONDITIONS.crossing_up, 30), true);
  });

  it('rejects a different level', () => {
    assert.equal(matchesAlert('ONTO Crossing 201.75', 'ONTO', CONDITIONS.crossing, 250), false);
  });

  it('tolerates the tick rounding TradingView applies', () => {
    // Live: asking for 19322 on TASE:NXSN stored "Crossing Down 19,320". Treating those as
    // different alerts is what duplicated the alert on the second run.
    assert.equal(matchesAlert('NXSN Crossing Down 19,320', 'NXSN', CONDITIONS.crossing_down, 19322), true);
  });

  it('still rejects a level a person would call different', () => {
    // 0.1% of 19322 is ~19; 100 away is a deliberate change, not a tick.
    assert.equal(matchesAlert('NXSN Crossing Down 19,220', 'NXSN', CONDITIONS.crossing_down, 19322), false);
    assert.equal(matchesAlert('ONTO Crossing 201.75', 'ONTO', CONDITIONS.crossing, 205), false);
  });

  it('keeps an absolute floor so cheap symbols are not over-merged', () => {
    // 0.1% of 6.89 is 0.007, below the 0.005 floor — the floor governs here.
    assert.equal(matchesAlert('QBTS Crossing 6.89', 'QBTS', CONDITIONS.crossing, 6.893), true);
    assert.equal(matchesAlert('QBTS Crossing 6.89', 'QBTS', CONDITIONS.crossing, 6.95), false);
  });

  it('rejects a different symbol, including a prefix of one', () => {
    assert.equal(matchesAlert('ONTO Crossing 201.75', 'ONT', CONDITIONS.crossing, 201.75), false);
    assert.equal(matchesAlert('ONTOX Crossing 201.75', 'ONTO', CONDITIONS.crossing, 201.75), false);
  });

  it('ignores an indicator alert that merely mentions the level', () => {
    const row =
      'Simple Moving Averages (20, close, 50, close) Crossing 2,432 on ARYT, 1D';
    assert.equal(matchesAlert(row, 'ARYT', CONDITIONS.crossing, 2432), false);
  });
});
