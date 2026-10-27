// The four content states. Status maps its five states onto these in its own components.
export type State = 'fresh' | 'stale' | 'broken' | 'neutral';

// A state word that is empty or only spaces would leave the mark standing alone, so it
// fails loudly at render instead of shipping.
export function requireWord(component: string, word: string): string {
  if (word.trim() === '') throw new Error(`${component} needs a visible state word.`);
  return word;
}
