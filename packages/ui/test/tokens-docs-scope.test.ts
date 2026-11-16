import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { docsPropertyNames } from '../src/tokens/generate.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

// The reader palette breaks the product's colour rules on purpose, for published docs only.
// These are the only places allowed to read it.
const ALLOWED = [
  /^apps\/docs-site\//,
  /^packages\/site\/(.+\/)?docs[^/]*(\/|\.[a-z]+$)/,
  /^packages\/ui\/src\/tokens\//,
  /^packages\/ui\/src\/generated\/surface-tokens\.ts$/,
  /^packages\/ui\/test\//,
];

// Never, not even the older docs layout measures every surface shares.
const BANNED = [/^apps\/dashboard\//, /^apps\/website\//, /^packages\/status\//];

const CODE = /\.(ts|tsx|js|mjs|cjs|jsx|css|mdx|html|astro)$/;
const TOKENS_DOCS = /\btokens\.docs\b/;

function tracked(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => CODE.test(file));
}

function readers(files: readonly string[], test: (text: string) => boolean): string[] {
  return files.filter((file) => {
    let text: string;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      return false;
    }
    return test(text);
  });
}

const files = tracked();
const names = docsPropertyNames();
const readsFamily = (text: string) =>
  names.some((name) => text.includes(name)) || TOKENS_DOCS.test(text);

describe('docs token scope', () => {
  it('scans the whole workspace', () => {
    expect(files).toContain('packages/ui/src/tokens/tokens.ts');
    expect(files.length).toBeGreaterThan(100);
  });

  it('is read only by the docs site and the docs templates', () => {
    const outside = readers(files, readsFamily).filter((f) => !ALLOWED.some((a) => a.test(f)));
    expect(outside).toEqual([]);
  });

  it('never reaches the dashboard, website or status pages', () => {
    const banned = files.filter((f) => BANNED.some((b) => b.test(f)));
    const hits = readers(banned, (text) => text.includes('--dr-docs-') || readsFamily(text));
    expect(hits).toEqual([]);
  });

  it('catches a reader outside the allowed places', () => {
    const allowed = (f: string) => ALLOWED.some((a) => a.test(f));
    expect(allowed('apps/dashboard/src/shell.tsx')).toBe(false);
    expect(allowed('packages/site/src/status/page.ts')).toBe(false);
    expect(allowed('packages/site/src/render.ts')).toBe(false);
    expect(allowed('packages/site/src/templates/docs/article.ts')).toBe(true);
    expect(allowed('packages/site/src/docs-reader.ts')).toBe(true);
    expect(allowed('apps/docs-site/src/page.tsx')).toBe(true);
    expect(readsFamily('color: var(--dr-docs-method-get);')).toBe(true);
    expect(readsFamily('x = tokens.docs.color')).toBe(true);
    expect(readsFamily('width: var(--dr-docs-nav);')).toBe(false);
  });
});
