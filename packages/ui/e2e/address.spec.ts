import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import * as address from '@drefyn/address';
import { expect, test, type Page } from '@playwright/test';
import ts from 'typescript';

// @drefyn/address is a pure entry, so client code may run it, and the browser's own URL
// host parser then does the IDNA step. Engines fold compatibility characters differently,
// so this runs the package itself in every engine and compares each answer with Node's.

const ORIGIN = 'http://address.localhost';
const manifestPath = createRequire(import.meta.url).resolve('@drefyn/address/package.json');
const pkgDir = dirname(manifestPath);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  exports: Record<string, string>;
};
const entry = manifest.exports['.'];
if (entry === undefined) throw new Error('@drefyn/address has no main entry');

// Each served module is the package source with its types removed and nothing else, so
// the browser resolves the package's own relative imports exactly as a bundler would.
function served(path: string): string | undefined {
  const file = resolve(pkgDir, `.${path}`);
  if (!file.startsWith(join(pkgDir, 'src') + sep) || !file.endsWith('.ts')) return undefined;
  return ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

async function openPackage(page: Page): Promise<string[]> {
  const elsewhere: string[] = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) {
      elsewhere.push(url.origin);
      await route.abort();
      return;
    }
    if (url.pathname === '/') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>a</title>' });
      return;
    }
    const body = served(url.pathname);
    await (body === undefined
      ? route.fulfill({ status: 404, body: '' })
      : route.fulfill({ contentType: 'text/javascript', body }));
  });
  await page.goto(`${ORIGIN}/`);
  return elsewhere;
}

interface Answer {
  readonly result: ReturnType<typeof address.normalizeEmailAddress>;
  readonly guard: boolean | null;
}

function answer(module: typeof address, input: string): Answer {
  const result = module.normalizeEmailAddress(input);
  return { result, guard: result.ok ? module.isNormalizedEmailAddress(result.value) : null };
}

async function inBrowser(page: Page, inputs: readonly string[]): Promise<Answer[]> {
  return page.evaluate(
    async ({ url, inputs }) => {
      const module = (await import(url)) as typeof address;
      return inputs.map((input) => {
        const result = module.normalizeEmailAddress(input);
        return { result, guard: result.ok ? module.isNormalizedEmailAddress(result.value) : null };
      });
    },
    { url: `${ORIGIN}${entry.slice(1)}`, inputs },
  );
}

// The ASCII delimiters the URL host parser acts on, their full width and small forms, and
// the default ignorable code points IDNA would drop. Every one must be refused everywhere.
const DELIMITERS = ['/', '?', '#', '\\', ':', '@', '%', ';', ' '];
const FORMS = [
  ...DELIMITERS,
  '\uff0f',
  '\uff1f',
  '\uff03',
  '\uff3c',
  '\uff1a',
  '\uff20',
  '\uff05',
  '\uff1b',
  '\u3000',
  '\ufe6b',
  '\ufe6a',
  '\ufe56',
  '\ufe5f',
  '\ufe68',
  '\ufe55',
  '=\u0338',
  '\u00ad',
  '\u200b',
  '\u2060',
  '\ufeff',
  '\ufe0f',
  '\u034f',
  '\u180b',
  '\u200c',
  '\u200d',
];
const BYPASSES = FORMS.flatMap((form) => [
  `jane@example.com${form}evil`,
  `jane@example.com${form}evil.com`,
  `jane@ex${form}41mple.com`,
  `jane@foo${form}example.com`,
]);

const REAL = [
  'a.b+c@Example.COM',
  '  Jane.Doe+Docs@Example.COM ',
  'max@B\u00fccher.example',
  'max@xn--bcher-kva.example',
  'jane@m\u00fcnchen.de',
  'jane@stra\u00dfe.de',
  'max@fa\u00df.de',
  'ivan@\u043f\u0440\u0438\u043c\u0435\u0440.\u0440\u0444',
  'taro@\u4f8b\u3048.jp',
  'jane@\uff45xample.com',
  'jane@example\u3002com',
  'jane@example\uff61com',
  'jane@mail-1.example2.co',
  "!#$%&'*+-/=?^_`{|}~@example.com",
  `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`,
];

test('every engine refuses the delimiter and ignorable bypasses, as Node does', async ({
  page,
}) => {
  const elsewhere = await openPackage(page);
  const got = await inBrowser(page, BYPASSES);
  BYPASSES.forEach((input, i) => {
    const node = answer(address, input);
    expect(node.result.ok, `Node accepted ${JSON.stringify(input)}`).toBe(false);
    expect(got[i], JSON.stringify(input)).toEqual(node);
  });
  expect(elsewhere).toEqual([]);
});

test('every engine gives Node answer for real addresses', async ({ page }) => {
  const elsewhere = await openPackage(page);
  const got = await inBrowser(page, REAL);
  REAL.forEach((input, i) => {
    const node = answer(address, input);
    expect(node.result.ok, `Node refused ${JSON.stringify(input)}`).toBe(true);
    expect(got[i], JSON.stringify(input)).toEqual(node);
  });
  expect(elsewhere).toEqual([]);
});
