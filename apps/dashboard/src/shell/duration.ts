// A CSS time in milliseconds. Minifiers rewrite 6000ms as 6s, so both units are read.
// Anything else is undefined rather than a guess.
export function durationMs(value: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)(ms|s)\s*$/.exec(value);
  if (match === null) return undefined;
  const amount = Number(match[1]);
  return match[2] === 's' ? amount * 1000 : amount;
}
