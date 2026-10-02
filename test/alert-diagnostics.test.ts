import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDiagnostics, pruneDiagnostics, DiagPage, MAX_DIAGNOSTIC_SETS } from '../src/alert-diagnostics';

const CTX = { symbol: 'EURONEXT:THEON', level: 14.78, condition: 'crossing_down', error: 'price input not found' };

function fakePage(over: Partial<DiagPage> = {}): DiagPage {
  return {
    url: () => 'https://www.tradingview.com/chart/?symbol=EURONEXT%3ATHEON',
    screenshot: async ({ path }) => writeFile(path, 'PNG'),
    evaluate: async () => ({ dialogPresent: true, qaIds: ['submit'], inputs: [] }),
    ...over,
  };
}

const tmp = (): Promise<string> => mkdtemp(join(tmpdir(), 'tv-diag-'));

describe('captureDiagnostics', () => {
  it('writes a screenshot and a JSON snapshot that carry the failing context', async () => {
    const dir = await tmp();
    const stem = await captureDiagnostics(fakePage(), CTX, dir);
    assert.ok(stem);
    assert.equal((await readFile(`${stem}.png`, 'utf8')), 'PNG');
    const j = JSON.parse(await readFile(`${stem}.json`, 'utf8'));
    assert.equal(j.symbol, 'EURONEXT:THEON');
    assert.equal(j.level, 14.78);
    assert.equal(j.error, 'price input not found');
    assert.equal(j.url, 'https://www.tradingview.com/chart/?symbol=EURONEXT%3ATHEON');
    assert.equal(j.snapshot.dialogPresent, true);
  });

  it('puts the symbol and error in a filesystem-safe file name', async () => {
    const dir = await tmp();
    await captureDiagnostics(fakePage(), { ...CTX, error: 'could not set the alert source to Price (chart offered "SMA")' }, dir);
    const names = await readdir(dir);
    assert.equal(names.length, 2);
    for (const n of names) assert.match(n, /^[A-Za-z0-9_.-]+$/);
  });

  it('keeps the JSON when the screenshot fails', async () => {
    const dir = await tmp();
    const stem = await captureDiagnostics(fakePage({ screenshot: async () => { throw new Error('page closed'); } }), CTX, dir);
    assert.ok(stem);
    assert.ok(JSON.parse(await readFile(`${stem}.json`, 'utf8')));
  });

  it('records the snapshot error and still saves when the page cannot be evaluated', async () => {
    const dir = await tmp();
    const stem = await captureDiagnostics(fakePage({ evaluate: async () => { throw new Error('Execution context was destroyed'); } }), CTX, dir);
    const j = JSON.parse(await readFile(`${stem}.json`, 'utf8'));
    assert.equal(j.snapshot, null);
    assert.match(j.snapshotError, /Execution context was destroyed/);
  });

  it('never throws, even when the directory cannot be created', async () => {
    const dir = await tmp();
    const blocker = join(dir, 'file');
    await writeFile(blocker, 'x');
    // A path beneath a regular file cannot be a directory.
    assert.equal(await captureDiagnostics(fakePage(), CTX, join(blocker, 'sub')), undefined);
  });
});

describe('pruneDiagnostics', () => {
  it('keeps the newest sets and removes the png together with its json', async () => {
    const dir = await tmp();
    for (let i = 1; i <= 5; i++) {
      const stem = `2026-10-0${i}T00-00-00-000Z-X-err`;
      await writeFile(join(dir, `${stem}.json`), '{}');
      await writeFile(join(dir, `${stem}.png`), 'p');
    }
    assert.equal(await pruneDiagnostics(dir, 2), 3);
    assert.deepEqual((await readdir(dir)).sort(), [
      '2026-10-04T00-00-00-000Z-X-err.json',
      '2026-10-04T00-00-00-000Z-X-err.png',
      '2026-10-05T00-00-00-000Z-X-err.json',
      '2026-10-05T00-00-00-000Z-X-err.png',
    ]);
  });

  it('leaves unrelated files alone and removes nothing under the limit', async () => {
    const dir = await tmp();
    await writeFile(join(dir, 'notes.txt'), 'keep me');
    await writeFile(join(dir, '2026-10-01T00-00-00-000Z-X-err.json'), '{}');
    assert.equal(await pruneDiagnostics(dir, MAX_DIAGNOSTIC_SETS), 0);
    assert.equal((await readdir(dir)).length, 2);
  });

  it('is applied by capture: the directory never grows past the limit', async () => {
    const dir = await tmp();
    for (let i = 0; i < MAX_DIAGNOSTIC_SETS; i++) {
      await writeFile(join(dir, `2000-01-01T00-00-${String(i).padStart(2, '0')}-000Z-X-err.json`), '{}');
    }
    await captureDiagnostics(fakePage(), CTX, dir);
    const stems = new Set((await readdir(dir)).map((n) => n.replace(/\.(json|png)$/, '')));
    assert.equal(stems.size, MAX_DIAGNOSTIC_SETS);
  });
});
