import { themeStorageKey } from '@drefyn/ui';

export type ThemeChoice = 'system' | 'light' | 'dark';

// The same storage key the head script reads, so a choice survives a reload with no flash.
// System clears both, and the stylesheet follows the operating system again.
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  try {
    if (choice === 'system') localStorage.removeItem(themeStorageKey);
    else localStorage.setItem(themeStorageKey, choice);
  } catch {
    // Storage can be off; the choice still applies to this page.
  }
  if (choice === 'system') delete root.dataset['theme'];
  else root.dataset['theme'] = choice;
}

export function currentTheme(): ThemeChoice {
  const value = document.documentElement.dataset['theme'];
  return value === 'light' || value === 'dark' ? value : 'system';
}
