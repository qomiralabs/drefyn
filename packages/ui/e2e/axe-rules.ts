import type { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';

type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;

// A menu item that shows its shortcut key is named by its label alone and announces the key
// through aria-keyshortcuts. An option that shows a description under its label is named by
// the label and announces the description through aria-describedby. axe's
// label-content-name-mismatch counts the key or the description as visible label text and
// fails both, but WCAG 2.5.3 is met: the visible label text is contained in the name, and the
// key and the description are separate cues. Only those exact cases are let through: a menu
// item with aria-keyshortcuts, or an option whose description is exactly what its
// aria-describedby points at, and in both the visible text without the cue must still be
// contained in its name. Every other mismatch fails.
export const SHORTCUT_ITEM_RULE = 'label-content-name-mismatch';

async function isSeparateCue(page: Page, target: string): Promise<boolean> {
  return page.locator(target).evaluate((el) => {
    const shortcut = el.matches('[role="menuitem"][aria-keyshortcuts]');
    const described = el.matches('[role="option"][aria-describedby]');
    if (!shortcut && !described) return false;
    const squash = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
    const ids = (attribute: string) =>
      (el.getAttribute(attribute) ?? '').split(/\s+/).filter((id) => id !== '');
    const clone = el.cloneNode(true) as Element;
    if (shortcut) for (const key of clone.querySelectorAll('kbd')) key.remove();
    if (described) {
      for (const id of ids('aria-describedby')) {
        // Only a description inside the option counts as its cue.
        if (el.querySelector(`[id="${CSS.escape(id)}"]`) === null) return false;
        clone.querySelector(`[id="${CSS.escape(id)}"]`)?.remove();
      }
    }
    const visible = squash(clone.textContent);
    const labelledBy = ids('aria-labelledby')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    const name = squash(labelledBy === '' ? (el.getAttribute('aria-label') ?? '') : labelledBy);
    return visible !== '' && name.includes(visible);
  });
}

// The violations to report, as readable lines, with only the separate cue cases removed.
export async function reportedViolations(page: Page, results: AxeResults): Promise<string[]> {
  const lines: string[] = [];
  for (const violation of results.violations) {
    const nodes = [];
    for (const node of violation.nodes) {
      const target = node.target.join(' ');
      if (violation.id === SHORTCUT_ITEM_RULE && (await isSeparateCue(page, target))) continue;
      nodes.push(target);
    }
    if (nodes.length > 0) lines.push(`${violation.id} (${nodes.length}): ${nodes.join(', ')}`);
  }
  return lines;
}
