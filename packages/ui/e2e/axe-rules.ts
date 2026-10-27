import type { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';

type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;

// A menu item that shows its shortcut key is named by its label alone and announces the key
// through aria-keyshortcuts. axe's label-content-name-mismatch counts the key as visible
// label text and fails it, but WCAG 2.5.3 is met: the visible label text is contained in the
// name, and the key is a separate shortcut cue. Only that exact case is let through: the
// element must be a menu item with aria-keyshortcuts, and its visible text without the key
// must still be contained in its name. Every other mismatch fails.
export const SHORTCUT_ITEM_RULE = 'label-content-name-mismatch';

async function isShortcutItem(page: Page, target: string): Promise<boolean> {
  return page.locator(target).evaluate((el) => {
    if (!el.matches('[role="menuitem"][aria-keyshortcuts]')) return false;
    const squash = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
    const clone = el.cloneNode(true) as Element;
    for (const key of clone.querySelectorAll('kbd')) key.remove();
    const visible = squash(clone.textContent);
    const labelledBy = (el.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .filter((id) => id !== '')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    const name = squash(labelledBy === '' ? (el.getAttribute('aria-label') ?? '') : labelledBy);
    return visible !== '' && name.includes(visible);
  });
}

// The violations to report, as readable lines, with only the shortcut item case removed.
export async function reportedViolations(page: Page, results: AxeResults): Promise<string[]> {
  const lines: string[] = [];
  for (const violation of results.violations) {
    const nodes = [];
    for (const node of violation.nodes) {
      const target = node.target.join(' ');
      if (violation.id === SHORTCUT_ITEM_RULE && (await isShortcutItem(page, target))) continue;
      nodes.push(target);
    }
    if (nodes.length > 0) lines.push(`${violation.id} (${nodes.length}): ${nodes.join(', ')}`);
  }
  return lines;
}
