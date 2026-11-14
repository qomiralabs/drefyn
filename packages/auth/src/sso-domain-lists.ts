import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthError } from './errors.ts';
import {
  normalizeSsoDomain,
  parsePublicSuffixList,
  type PublicSuffixList,
} from './sso-domain-rules.ts';

const KEY = 'DREFYN_AUTH_SSO_FREE_MAIL_DOMAINS_FILE';
// Many times the largest published free mail list, small enough to read at start.
const MAX_FREE_MAIL_BYTES = 1024 * 1024;
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

// Joined by hand rather than through new URL(path, import.meta.url), so the path is the
// same whether this runs from source or a bundle that copied the data folder beside it.
export function bundledPublicSuffixListPath(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'data',
    'public-suffix-list',
    'public_suffix_list.txt',
  );
}

// The snapshot shipped with this package, unchanged. Read once at start by the caller.
export async function loadPublicSuffixList(
  path: string = bundledPublicSuffixListPath(),
): Promise<PublicSuffixList> {
  return parsePublicSuffixList(await readFile(path, 'utf8'));
}

const invalid = (reason: string, cause?: unknown) =>
  new AuthError('AUTH_CONFIG_INVALID', { key: KEY, reason, cause });

// One domain a line, # starts a comment. Any line that is not a domain fails the whole
// file, since a typo there would quietly leave a provider claimable. The error never
// repeats the line.
export function parseFreeMailDomains(text: string): readonly string[] {
  const found = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const hash = raw.indexOf('#');
    const line = (hash < 0 ? raw : raw.slice(0, hash)).trim();
    if (line === '') continue;
    const domain = normalizeSsoDomain(line);
    if (domain === null) throw invalid('holds a line that is not a domain');
    found.add(domain);
  }
  return Object.freeze([...found]);
}

export async function loadFreeMailDomains(path: string): Promise<readonly string[]> {
  let bytes: Buffer;
  try {
    const info = await stat(path);
    if (info.size > MAX_FREE_MAIL_BYTES) throw invalid('is larger than 1 MiB');
    bytes = await readFile(path);
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw invalid('could not be read', error);
  }
  let text: string;
  try {
    text = STRICT_UTF8.decode(bytes);
  } catch (error) {
    throw invalid('is not UTF-8 text', error);
  }
  return parseFreeMailDomains(text);
}
