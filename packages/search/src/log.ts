export type LogFields = Readonly<Record<string, string | number | boolean>>;

// Fields are public ids, codes, counts and timings. Never the query text, a snippet, a key or
// an address: what a reader typed into a search box is theirs, and the log is the first place
// it would leak.
export interface SearchLogger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export const noopLogger: SearchLogger = Object.freeze({
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});
