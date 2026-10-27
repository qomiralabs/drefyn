// Keyboard rules for the shell, kept apart from React so they can be tested on their own.

// Where focus goes on F6 (forward) or Shift+F6 (back). From outside every region, forward
// starts at the first and back at the last.
export function nextRegion(current: number, count: number, back: boolean): number {
  if (count === 0) return -1;
  if (current < 0) return back ? count - 1 : 0;
  return (current + (back ? count - 1 : 1)) % count;
}

// Single key shortcuts must not fire while someone types.
export function isTyping(el: Element | null): boolean {
  if (el === null) return false;
  if ((el as { isContentEditable?: boolean }).isContentEditable === true) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (el.getAttribute('type') ?? 'text').toLowerCase();
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(
    type,
  );
}

// G then a key, within a second: 1, 2 and 3 open the products in suite order, O the overview.
export const SEQUENCE_WINDOW_MS = 1000;

const SEQUENCES: Readonly<Record<string, string>> = {
  '1': 'docs',
  '2': 'studio',
  '3': 'status',
  o: 'overview',
};

export function sequenceTarget(
  pending: { key: string; at: number } | null,
  key: string,
  now: number,
): string | null {
  if (pending?.key !== 'g' || now - pending.at > SEQUENCE_WINDOW_MS) return null;
  return SEQUENCES[key] ?? null;
}
