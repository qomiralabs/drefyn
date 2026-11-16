import { createHash } from 'node:crypto';

// The HTML parser turns CR LF and a lone CR into LF, and NUL into U+FFFD, before a browser
// hashes an inline element. Emitting the text already in that form keeps our hash and the
// browser's the same.
export function inlineText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\0/g, '�');
}

export function inlineHash(text: string): string {
  return `'sha256-${createHash('sha256').update(inlineText(text), 'utf8').digest('base64')}'`;
}

export interface InlineHashes {
  readonly scripts: readonly string[];
  readonly styles: readonly string[];
}

export interface Policy {
  // For the response header, where every directive works.
  readonly header: string;
  // For a plain static host that sets no header. A browser ignores frame-ancestors in a
  // meta tag and warns about it, so it is left out.
  readonly meta: string;
}

const sources = (hashes: readonly string[]): string[] => [...new Set(hashes)].sort();

// Plain scripts load from the page's own origin and the one inline theme line by hash, so
// injected markup can neither run nor style the page. Hashes, not nonces, because a static
// file cannot carry a fresh nonce per response.
export function contentSecurityPolicy({ scripts, styles }: InlineHashes): Policy {
  const styleSources = sources(styles);
  const directives: [string, string[]][] = [
    ['default-src', ["'none'"]],
    ['script-src', ["'self'", ...sources(scripts)]],
    ['style-src', styleSources.length === 0 ? ["'none'"] : styleSources],
    ['img-src', ["'self'", 'data:']],
    ['font-src', ["'self'"]],
    ['connect-src', ["'self'"]],
    ['form-action', ["'self'"]],
    ['base-uri', ["'none'"]],
    ['object-src', ["'none'"]],
  ];
  const meta = directives.map(([name, values]) => `${name} ${values.join(' ')}`).join(';');
  return { header: `${meta};frame-ancestors 'none'`, meta };
}
