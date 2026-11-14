import { z } from 'zod';

export const DOCS_URL_KEY = 'DREFYN_DOCS_URL';
export const DEFAULT_DOCS_URL = 'https://docs.drefyn.com';

const DocsUrl = z.url({ protocol: /^https?$/ });

// A self hosted server can point people at its own copy of the docs. Unset means ours. A bad
// value throws, naming the key and never the value, so a typo fails at the first page and
// never ships a link that goes somewhere odd.
export function docsUrl(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const raw = env[DOCS_URL_KEY];
  if (raw === undefined || raw === '') return DEFAULT_DOCS_URL;
  const parsed = DocsUrl.safeParse(raw);
  if (!parsed.success) throw new Error(`${DOCS_URL_KEY} is not an http or https URL`);
  return parsed.data;
}
