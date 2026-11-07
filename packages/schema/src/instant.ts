import { z } from 'zod';

const dateOnly = z.iso.date();
const dateTime = z.iso.datetime({ offset: true });
// Postgres has no year 0000, and a shift by offset can land there or past four digits. Only the
// shifted value shows either, so this is checked after it.
const READABLE_YEAR = /^(?!0000)[0-9]{4}-/;

// The one form a date is stored and compared in, or null for anything Postgres could not read.
export function canonicalInstant(value: unknown, withTime: boolean): string | null {
  if (!(withTime ? dateTime : dateOnly).safeParse(value).success) return null;
  const instant = new Date(value as string).toISOString();
  return READABLE_YEAR.test(instant) ? instant : null;
}
