import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderDocsPage, renderStatusPage } from '../src/index.ts';
import { pageInput } from './fixtures.ts';

const src = join(dirname(fileURLToPath(import.meta.url)), '../src');

const page = fc.record({
  title: fc.string({ maxLength: 80 }),
  description: fc.string({ maxLength: 160 }),
  text: fc.string({ maxLength: 400 }),
  className: fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/),
  ground: fc.stringMatching(/^#[0-9A-F]{6}$/),
  version: fc.string({ minLength: 1, maxLength: 20 }),
});

type PageCase = typeof page extends fc.Arbitrary<infer T> ? T : never;

function input(c: PageCase) {
  return pageInput(
    { theme: { light: { '--dr-surface-ground': c.ground } } },
    {
      version: c.version,
      css: `.${c.className}{color:var(--dr-text-ink)}`,
      pages: new Map([
        [
          '/',
          {
            title: c.title,
            description: c.description,
            body: createElement('main', { className: c.className }, c.text),
          },
        ],
      ]),
    },
  );
}

describe.each([
  ['docs', renderDocsPage],
  ['status', renderStatusPage],
] as const)('%s render', (_, render) => {
  it('gives the same bytes for the same input', () => {
    fc.assert(
      fc.property(page, (c) => {
        const first = render(input(c));
        const second = render(input(c));
        expect(second).toEqual(first);
        expect(first.ok).toBe(true);
      }),
    );
  });

  it('never lets page text out of its place in the head', () => {
    fc.assert(
      fc.property(
        page,
        fc.constantFrom('</title><script>x</script>', '"><img src=x>'),
        (c, bad) => {
          const result = render(input({ ...c, title: bad, description: bad }));
          expect(result.ok).toBe(true);
          if (result.ok) expect(result.value.html).not.toContain(bad);
        },
      ),
    );
  });
});

describe('no clock and no random source', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds the same bytes across a fake clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2001-01-01T00:00:00Z'));
    const before = renderStatusPage(pageInput());
    vi.setSystemTime(new Date('2031-06-15T09:30:00Z'));
    const after = renderStatusPage(pageInput());
    expect(after).toEqual(before);
  });

  it('prints the build time it is given and no other', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2031-06-15T09:30:00Z'));
    const result = renderStatusPage(pageInput({}, { builtAt: '2026-01-02T03:04:05.000Z' }));
    expect(result.ok && result.value.html).toContain('2026-01-02T03:04:05.000Z');
    expect(result.ok && result.value.html).not.toContain('2031');
  });

  it('survives a random source that changes on every call', () => {
    const first = renderDocsPage(pageInput());
    let next = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => (next += 0.001));
    expect(renderDocsPage(pageInput())).toEqual(first);
  });

  it('names no time, random or environment source in the render files', () => {
    const files = readdirSync(src).filter((f) => f.endsWith('.ts') && f !== 'config.ts');
    expect(files).toContain('render.ts');
    for (const file of files) {
      const text = readFileSync(join(src, file), 'utf8');
      expect(text, file).not.toMatch(
        /\bDate\b|Math\.random|performance\.|randomUUID|randomBytes|getRandomValues|process\.env|hrtime/,
      );
    }
  });

  it('keeps the page body it was given', () => {
    const result = renderDocsPage(pageInput());
    expect(result.ok && result.value.html).toContain(
      '<main class="page"><p>Everything is running.</p></main>',
    );
  });
});
