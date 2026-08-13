import type { Page } from 'playwright';
import { dismissPopups } from './driver';

/**
 * alerts.ts — create and list TradingView price alerts through the logged-in profile.
 *
 * Kept out of driver.ts because the alert surface breaks that file's central assumption:
 * every other panel in this repo is reachable by `data-name`, and the alert DIALOG has no
 * `data-name` on a single element. It exposes `data-qa-id` on the price input, `role` +
 * `data-qa-id` on the condition options, and nothing at all on its buttons — those have to
 * be matched by visible text. Selectors here are therefore more fragile than elsewhere in
 * the repo, and ALERT_SELECTORS documents which anchor each one uses so a TradingView
 * redesign can be repaired without re-deriving all of it. Established by DOM inspection
 * 2026-08-13.
 *
 * The alerts PANEL is better behaved: `data-test-id-widget-type="alerts"` for the panel,
 * `data-name="alert-item-description"` per row, and `alert-delete-button` / `alert-edit-button`
 * / `alert-stop-button` revealed inside a row on hover.
 */

function log(msg: string): void {
  process.stderr.write(`${new Date().toISOString()} ${msg}\n`);
}

export const ALERT_SELECTORS = {
  /** Right-rail bell. Stable `data-name`. */
  panelButton: 'button[data-name="alerts"]',
  /** The alerts side panel. Stable `data-test-id-widget-type`. */
  panel: 'div[data-test-id-widget-type="alerts"]',
  /** One row's title line, e.g. "ONTO Crossing 201.75". Stable `data-name`. */
  rowDescription: 'div[data-name="alert-item-description"]',
  /** Per-row action, revealed on hover. Scope it to the row body — it is absent globally. */
  rowDelete: '[data-name="alert-delete-button"]',
  /** The create/edit dialog. No data-name; `data-focus-trap` is the only stable hook. */
  dialog: 'div[data-focus-trap="true"]',
  /** Price field inside the dialog. Anchored on data-qa-id, which TV does expose here. */
  priceInput: 'input[data-qa-id*="end-band-range-input"]',
  /** Condition options in the operator dropdown. */
  operatorItem: '[data-qa-id="primary-operator-dropdown-item"]',
  chartCanvas: 'canvas[data-name="pane-canvas"]',
} as const;

/** Condition wording as TradingView renders it in the operator dropdown. */
export const CONDITIONS = {
  crossing: 'Crossing',
  crossing_up: 'Crossing Up',
  crossing_down: 'Crossing Down',
} as const;

export type ConditionKey = keyof typeof CONDITIONS;

export interface CreateAlertSpec {
  /** Exchange-qualified symbol, e.g. "NYSE:ONTO". Qualify before calling. */
  symbol: string;
  price: number;
  /** Defaults to crossing_down — the direction a stop cares about. */
  condition?: ConditionKey;
  /** Overrides TradingView's auto-generated "SYMBOL Crossing 123.45". */
  message?: string;
}

export interface AlertRow {
  /** The row's title line as TradingView renders it. */
  description: string;
  /** Remaining row text — symbol and status, e.g. "ONTO" / "Stopped — Triggered". */
  detail: string;
}

/**
 * Open the alerts side panel.
 *
 * Must test VISIBILITY, not presence: TradingView keeps the panel element mounted while the
 * rail is collapsed, so an existence check returns true for a panel nobody can see and the
 * rows read back empty. That produced a confident "0 alerts" against an account holding
 * three of them. The bell is a toggle, so clicking an already-open panel would close it.
 */
async function openPanel(page: Page): Promise<boolean> {
  if (await page.locator(ALERT_SELECTORS.panel).isVisible().catch(() => false)) return true;
  await page.click(ALERT_SELECTORS.panelButton).catch(() => undefined);
  // waitFor POLLS. driver.ts's tryWithin does not — it races one call against a timer, so
  // `tryWithin(6000, () => page.$(x))` resolves null immediately when x is not there yet.
  return page
    .locator(ALERT_SELECTORS.panel)
    .waitFor({ state: 'visible', timeout: 6000 })
    .then(() => true)
    .catch(() => false);
}

/**
 * Every alert currently in the account, as the panel shows them.
 *
 * Reads the panel rather than an API: TradingView's alert endpoints are not public, and
 * the whole point of this server is to drive the session the user already owns.
 */
export async function listAlerts(page: Page): Promise<AlertRow[]> {
  await dismissPopups(page);
  if (!(await openPanel(page))) {
    log('  ⚠️ alerts panel did not open');
    return [];
  }
  await page.waitForTimeout(1500);

  return page.evaluate((sel: string) => {
    const out: { description: string; detail: string }[] = [];
    const nodes = Array.prototype.slice.call(document.querySelectorAll(sel)) as Element[];
    for (const el of nodes) {
      const description = (el.textContent || '').trim();
      if (!description) continue;
      // The row body holds the description plus the symbol/status line; subtracting the
      // former leaves the latter without depending on TradingView's hashed class names.
      const body = el.parentElement;
      const full = body ? (body.textContent || '').trim() : description;
      out.push({ description, detail: full.slice(description.length).trim() });
    }
    return out;
  }, ALERT_SELECTORS.rowDescription);
}

export interface CreateAlertResult {
  created: boolean;
  /** Set when `created` is false and an equivalent alert was already present. */
  existing?: string;
  /** Set when `created` is false and something went wrong. */
  error?: string;
  description?: string;
}

/**
 * Relative slack when comparing a requested level to the one TradingView stored.
 *
 * TradingView snaps the level to the instrument's tick: asking for 19322 on TASE:NXSN
 * produced "Crossing Down 19,320". An exact compare therefore fails BOTH the idempotency
 * check and the post-create verification — observed live, and it duplicated the alert.
 * 0.1% clears a tick on any instrument here while staying far below the distance between
 * two levels anyone would set deliberately.
 */
export const LEVEL_TOLERANCE_PCT = 0.001;

/**
 * True when a panel row is the alert this spec would create.
 *
 * Compared field-by-field rather than as a string: TradingView renders the level with
 * thousands separators in its own titles ("Crossing 2,432"), so a string compare against
 * "Crossing 2432" would never fire and every run would duplicate.
 * Exported for tests; no DOM involved.
 */
export function matchesAlert(
  rowDescription: string,
  bareSymbol: string,
  conditionLabel: string,
  price: number,
): boolean {
  const normalized = rowDescription.replace(/,/g, '');
  if (!normalized.startsWith(`${bareSymbol} `)) return false;
  // "Crossing Down" contains "Crossing", so a plain Crossing spec must not match a
  // directional row. Anchor on the operator sitting immediately after the symbol.
  const rest = normalized.slice(bareSymbol.length + 1);
  if (!rest.startsWith(`${conditionLabel} `)) return false;
  const level = Number(rest.slice(conditionLabel.length + 1).trim().split(/\s/)[0]);
  if (!Number.isFinite(level)) return false;
  const tolerance = Math.max(0.005, Math.abs(price) * LEVEL_TOLERANCE_PCT);
  return Math.abs(level - price) <= tolerance;
}

/**
 * Create one price alert.
 *
 * Idempotent by description: if the panel already carries a row whose title matches what
 * TradingView would generate for this symbol/condition/price, nothing is created. Without
 * that guard a twice-daily caller would accumulate duplicates forever.
 */
export async function createAlert(page: Page, spec: CreateAlertSpec): Promise<CreateAlertResult> {
  const condition = spec.condition ?? 'crossing_down';
  const bare = spec.symbol.split(':').pop() ?? spec.symbol;
  // TradingView's own wording, so the idempotency check compares like with like.
  const expected = spec.message ?? `${bare} ${CONDITIONS[condition]} ${spec.price}`;

  const existingRows = await listAlerts(page);
  const dup = existingRows.find((r) =>
    matchesAlert(r.description, bare, CONDITIONS[condition], spec.price),
  );
  if (dup) {
    log(`  = ${expected} already exists`);
    return { created: false, existing: dup.description, description: expected };
  }

  log(`  📢 creating alert: ${spec.symbol} ${CONDITIONS[condition]} ${spec.price}`);
  await page.goto(`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(spec.symbol)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForTimeout(7000);
  await dismissPopups(page);

  // The chart must hold focus or Alt+A is swallowed by whatever widget has it. An invalid
  // symbol reaches this point too and fails with TradingView's own "invalid symbol" modal,
  // which is why callers should qualify the symbol first.
  await page
    .click(ALERT_SELECTORS.chartCanvas, { position: { x: 400, y: 250 }, force: true })
    .catch(() => undefined);
  await page.waitForTimeout(600);
  await page.keyboard.press('Alt+a').catch(() => undefined);

  // Wait on the heading, not just the focus-trap div: the alerts side panel can also be a
  // focus trap, so the container alone does not prove the CREATE dialog is what appeared.
  const opened = await page
    .getByText(/^Create alert on/)
    .first()
    .waitFor({ state: 'visible', timeout: 12000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) {
    return { created: false, error: 'alert dialog did not open', description: expected };
  }
  await page.waitForTimeout(800);

  // Condition. The current value is the button's label, so click it by its current text.
  if (condition !== 'crossing') {
    const opener = page.getByRole('button', { name: CONDITIONS.crossing, exact: true }).first();
    await opener.click().catch(() => undefined);
    await page.waitForTimeout(900);
    // Match on textContent via element handles rather than locator.filter({ hasText }).
    // hasText compares Playwright's rendered innerText, which did not match these options
    // even though their textContent is exactly "Crossing Down" — verified against the live
    // dropdown, where the filter returned 0 of 3 visible items.
    let picked = false;
    for (const handle of await page.$$(ALERT_SELECTORS.operatorItem)) {
      const label = (await handle.textContent())?.trim();
      if (label !== CONDITIONS[condition]) continue;
      picked = await handle
        .click({ timeout: 4000 })
        .then(() => true)
        .catch(() => false);
      break;
    }
    if (!picked) {
      await page.keyboard.press('Escape').catch(() => undefined);
      return { created: false, error: `condition "${CONDITIONS[condition]}" not selectable`, description: expected };
    }
    await page.waitForTimeout(700);
  }

  // Price.
  const input = await page.$(ALERT_SELECTORS.priceInput);
  if (!input) {
    await page.keyboard.press('Escape').catch(() => undefined);
    return { created: false, error: 'price input not found', description: expected };
  }
  await input.fill('');
  await page.waitForTimeout(200);
  await input.type(String(spec.price), { delay: 40 });
  await page.waitForTimeout(600);

  const submitted = await page
    .getByRole('button', { name: 'Create', exact: true })
    .first()
    .click({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!submitted) {
    await page.keyboard.press('Escape').catch(() => undefined);
    return { created: false, error: 'Create button not clickable', description: expected };
  }
  await page.waitForTimeout(2500);

  // Confirm against the panel rather than trusting the click: a rejected alert (plan limit,
  // invalid level) leaves the dialog up and would otherwise be reported as success.
  const after = await listAlerts(page);
  const landed = after.find((r) =>
    matchesAlert(r.description, bare, CONDITIONS[condition], spec.price),
  );
  if (!landed) {
    return { created: false, error: 'alert not visible in the panel after Create', description: expected };
  }
  // Report the level TradingView actually stored, not the one that was asked for — they
  // differ whenever the instrument's tick rounds it, and the caller should see the truth.
  return { created: true, description: landed.description };
}

export interface DeleteAlertResult {
  /** Rows that actually disappeared, measured before vs after — not clicks attempted. */
  deleted: number;
  /** Descriptions of the rows targeted, as they read before deletion. */
  removed: string[];
  remaining: number;
}

/**
 * Delete every alert whose title contains `descriptionContains` (case-insensitive,
 * commas ignored so a caller can pass an unformatted level).
 *
 * Deletes ALL matches rather than the first: the reason this exists is that a tick-rounding
 * bug produced two identical rows, and a first-only delete would have left one behind and
 * looked like it had worked.
 *
 * Rows are re-queried after every removal — the list re-renders, so handles from the first
 * pass go stale immediately.
 */
export async function deleteAlerts(page: Page, descriptionContains: string): Promise<DeleteAlertResult> {
  const needle = descriptionContains.replace(/,/g, '').toLowerCase().trim();
  if (!needle) return { deleted: 0, removed: [], remaining: (await listAlerts(page)).length };

  await dismissPopups(page);
  if (!(await openPanel(page))) {
    log('  ⚠️ alerts panel did not open');
    return { deleted: 0, removed: [], remaining: 0 };
  }
  const before = (await listAlerts(page)).length;

  const removed: string[] = [];
  // Bounded rather than while(true): a delete button that silently no-ops would otherwise
  // spin forever against the live account.
  for (let pass = 0; pass < 50; pass++) {
    await page.waitForTimeout(800);
    const rows = await page.$$(ALERT_SELECTORS.rowDescription);
    let target: { handle: (typeof rows)[number]; text: string } | null = null;
    for (const handle of rows) {
      const text = ((await handle.textContent()) || '').trim();
      if (text.replace(/,/g, '').toLowerCase().includes(needle)) {
        target = { handle, text };
        break;
      }
    }
    if (!target) break;

    // The action buttons live in the row body (the description's parent) and only render
    // while it is hovered.
    const body = await target.handle.evaluateHandle((el) => el.parentElement);
    const bodyEl = body.asElement();
    if (!bodyEl) break;
    await bodyEl.hover().catch(() => undefined);
    await page.waitForTimeout(400);
    const del = await bodyEl.$(ALERT_SELECTORS.rowDelete);
    if (!del) {
      log(`  ⚠️ no delete button on row: ${target.text.slice(0, 40)}`);
      break;
    }
    await del.click().catch(() => undefined);
    await page.waitForTimeout(900);

    // TradingView may ask to confirm; accept only an affirmative label so this never
    // clicks something destructive on an unexpected dialog.
    for (const label of ['Yes, delete', 'Delete', 'Yes']) {
      const confirm = page.getByRole('button', { name: label, exact: true }).first();
      if (await confirm.isVisible().catch(() => false)) {
        await confirm.click().catch(() => undefined);
        break;
      }
    }
    removed.push(target.text);
    log(`  🗑 deleted: ${target.text.slice(0, 50)}`);
  }

  // Count what actually went, not how many clicks were issued. A row mid-removal is still
  // briefly in the DOM and gets targeted again — that made a 2-row cleanup report "4".
  const remaining = (await listAlerts(page)).length;
  return { deleted: Math.max(0, before - remaining), removed, remaining };
}
