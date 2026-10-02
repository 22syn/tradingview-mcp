import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * alert-diagnostics.ts — evidence for alert-creation failures that cannot be reproduced on demand.
 *
 * Why this exists: in September 2026 THEON failed `price input not found` seven runs in a row
 * while ONTO, ORA, QBTS and WOLF succeeded in the same browser session, and then succeeded
 * with the same code. The log held the error string and nothing else, so the cause could not
 * be established. When a create fails, this saves what the browser was showing: a screenshot,
 * and a JSON snapshot of the dialog (its data-qa-ids, inputs, text and HTML) so the next
 * occurrence can be diagnosed instead of guessed at.
 *
 * It must never make a failure worse: everything here is best-effort and swallows its own errors.
 */

/** The slice of Playwright's Page this needs, so tests can fake it without a browser. */
export interface DiagPage {
  url(): string;
  screenshot(options: { path: string }): Promise<unknown>;
  evaluate(script: string): Promise<unknown>;
}

export interface DiagContext {
  symbol: string;
  level: number;
  condition: string;
  error: string;
}

/** Newest sets to keep. Each set is two files (png + json), so the directory stays bounded. */
export const MAX_DIAGNOSTIC_SETS = 30;

/**
 * Runs INSIDE the page, so it is a plain string, not a function. A function passed to
 * page.evaluate is serialised with toString(), and tsx's esbuild step injects a `__name(...)`
 * helper into any function that declares a named inner function; the page has no such helper
 * and the evaluate dies with "__name is not defined". That was caught only by running it in a
 * real browser (a fake page cannot see it), and it would have failed on every capture.
 * The dialog selector is ALERT_SELECTORS.dialog, repeated here on purpose.
 */
const SNAPSHOT_SCRIPT = `(() => {
  const dlg = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
  const scope = dlg || document;
  const text = (e, n) => (e.textContent || '').replace(/\\s+/g, ' ').slice(0, n);
  return {
    dialogPresent: !!dlg,
    pageTitle: document.title,
    qaIds: Array.from(new Set(Array.from(scope.querySelectorAll('[data-qa-id]')).map((e) => e.getAttribute('data-qa-id')))),
    inputs: Array.from(scope.querySelectorAll('input')).map((i) => ({
      qaId: i.getAttribute('data-qa-id'),
      type: i.type,
      value: i.value.slice(0, 40),
      visible: !!(i.offsetWidth || i.offsetHeight),
    })),
    dialogText: dlg ? text(dlg, 1500) : '',
    // Any other modal on top (an upsell, an invalid-symbol dialog) is a prime suspect.
    otherModals: Array.from(document.querySelectorAll('[role="dialog"]')).filter((d) => d !== dlg).map((d) => text(d, 200)),
    dialogHtml: dlg ? dlg.outerHTML.slice(0, 60000) : '',
  };
})()`;

export function diagnosticsDir(): string {
  return process.env.TV_DIAG_DIR ?? join(__dirname, '..', '.diagnostics');
}

const safeTag = (s: string): string => s.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60);

/**
 * Save a screenshot and a dialog snapshot. Returns the path stem (add .png / .json) or
 * undefined if nothing could be written. Call BEFORE dismissing the dialog.
 */
export async function captureDiagnostics(
  page: DiagPage,
  ctx: DiagContext,
  dir: string = diagnosticsDir(),
): Promise<string | undefined> {
  try {
    await mkdir(dir, { recursive: true });
    const stem = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeTag(ctx.symbol)}-${safeTag(ctx.error)}`);

    let snapshot: unknown = null;
    let snapshotError: string | undefined;
    try {
      snapshot = await page.evaluate(SNAPSHOT_SCRIPT);
    } catch (err) {
      snapshotError = String(err);
    }
    await writeFile(
      `${stem}.json`,
      JSON.stringify({ at: new Date().toISOString(), url: page.url(), ...ctx, snapshot, snapshotError }, null, 1),
    );
    // A missing screenshot must not lose the JSON.
    await page.screenshot({ path: `${stem}.png` }).catch(() => undefined);

    await pruneDiagnostics(dir).catch(() => undefined);
    return stem;
  } catch {
    return undefined;
  }
}

/** Keep the newest MAX_DIAGNOSTIC_SETS sets. Names start with an ISO timestamp, so name order is time order. */
export async function pruneDiagnostics(dir: string, keep: number = MAX_DIAGNOSTIC_SETS): Promise<number> {
  const names = (await readdir(dir)).filter((n) => /\.(json|png)$/.test(n));
  const stems = Array.from(new Set(names.map((n) => n.replace(/\.(json|png)$/, '')))).sort();
  const doomed = stems.slice(0, Math.max(0, stems.length - keep));
  for (const stem of doomed) {
    await rm(join(dir, `${stem}.json`), { force: true });
    await rm(join(dir, `${stem}.png`), { force: true });
  }
  return doomed.length;
}
