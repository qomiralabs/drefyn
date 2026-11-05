const COUNT_WORDS = [
  'Nothing',
  'One thing',
  'Two things',
  'Three things',
  'Four things',
  'Five things',
];

// "Two things need you." The sentence that opens the overview.
export function needsYouSentence(count: number): string {
  if (count === 0) return 'Nothing needs you.';
  const words = COUNT_WORDS[count] ?? `${count} things`;
  return `${words} ${count === 1 ? 'needs' : 'need'} you.`;
}
