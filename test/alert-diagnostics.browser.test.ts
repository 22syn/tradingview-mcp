import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, Browser, Page } from 'playwright';
import { captureDiagnostics } from '../src/alert-diagnostics';

/**
 * The snapshot script runs inside the page, which a fake page cannot exercise. This caught a
 * real bug: passed as a function, tsx injected `__name(...)` into it and every capture failed
 * with "__name is not defined". Skipped (not failed) when Chromium is not installed.
 */
const CTX = { symbol: 'EURONEXT:THEON', level: 14.78, condition: 'crossing_down', error: 'price input not found' };

const WITH_INPUT = `<body><div role="dialog" data-qa-id="alerts-create-edit-dialog"><div data-qa-id="main-series-select">Price</div>
<input data-qa-id="end-band-range-input" type="text" value="14.8"><button data-qa-id="submit">Create</button></div></body>`;
const WITHOUT_INPUT = `<body><div role="dialog" data-qa-id="alerts-create-edit-dialog"><div data-qa-id="main-series-select">Price</div>
<div data-qa-id="operator-dropdown">Crossing Down</div><button data-qa-id="submit">Create</button></div>
<div role="dialog">Upgrade your plan to add more alerts</div></body>`;

async function snapshotOf(page: Page, html: string): Promise<{ j: { snapshot: Record<string, unknown> | null; snapshotError?: string }; files: string[] }> {
  await page.setContent(html);
  const dir = await mkdtemp(join(tmpdir(), 'tv-real-'));
  const stem = await captureDiagnostics(page, CTX, dir);
  assert.ok(stem);
  return { j: JSON.parse(await readFile(`${stem}.json`, 'utf8')), files: await readdir(dir) };
}

describe('captureDiagnostics in a real browser', () => {
  let browser: Browser | undefined;
  let page: Page | undefined;

  before(async () => {
    try {
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage();
    } catch {
      browser = undefined;
    }
  });
  after(async () => {
    await browser?.close();
  });

  it('records the dialog and its price input', async (t) => {
    if (!page) return t.skip('Chromium not installed');
    const { j, files } = await snapshotOf(page, WITH_INPUT);
    assert.equal(j.snapshotError, undefined);
    assert.equal(j.snapshot?.dialogPresent, true);
    assert.deepEqual(j.snapshot?.qaIds, ['main-series-select', 'end-band-range-input', 'submit']);
    assert.deepEqual(j.snapshot?.inputs, [{ qaId: 'end-band-range-input', type: 'text', value: '14.8', visible: true }]);
    assert.ok(files.some((f) => f.endsWith('.png')));
  });

  it('shows the missing input and any other modal on top, which is the failure being hunted', async (t) => {
    if (!page) return t.skip('Chromium not installed');
    const { j } = await snapshotOf(page, WITHOUT_INPUT);
    assert.equal(j.snapshotError, undefined);
    assert.deepEqual(j.snapshot?.inputs, []);
    assert.deepEqual(j.snapshot?.otherModals, ['Upgrade your plan to add more alerts']);
    assert.match(String(j.snapshot?.dialogText), /Crossing Down/);
  });

  it('reports dialogPresent=false when the dialog is not on the page at all', async (t) => {
    if (!page) return t.skip('Chromium not installed');
    const { j } = await snapshotOf(page, '<body><p>chart</p></body>');
    assert.equal(j.snapshot?.dialogPresent, false);
  });
});
