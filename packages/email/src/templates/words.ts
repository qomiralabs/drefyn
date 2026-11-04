import type { LinkProvider } from '../types.ts';

export const PROVIDER: Readonly<Record<LinkProvider, string>> = {
  github: 'GitHub',
  google: 'Google',
};

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const pad = (n: number) => String(n).padStart(2, '0');

// Written by hand, not through Intl, so a date reads the same under any server locale.
export function utc(date: Date): string {
  const day = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()] ?? ''} ${date.getUTCFullYear()}`;
  return `${day} at ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

export const minutes = (n: number) => `${n} ${n === 1 ? 'minute' : 'minutes'}`;
