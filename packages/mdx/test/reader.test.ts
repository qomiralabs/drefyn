import { describe, expect, it } from 'vitest';
import { readerPage } from '../src/reader.ts';
import type { Dialect, RenderPolicy } from '../src/index.ts';
import { MAX_GROWTH, growthOf } from './cost.ts';
import { parsed, policy } from './helpers.ts';
import { unseenWords } from './reader-helpers.ts';

const LARGE_PAGE_TIMEOUT_MS = 60_000;

const read = (source: string, dialect: Dialect = 'md', use: RenderPolicy = policy()) =>
  readerPage(parsed(source, dialect, use), use);

const unitsOf = (source: string, dialect: Dialect = 'md', use: RenderPolicy = policy()) => {
  const page = read(source, dialect, use);
  if (page.state !== 'ok') throw new Error('not renderable');
  return page.units;
};

const POLICIES = [
  ['sanitize', policy({ components: new Set(['Note']) })],
  ['drop', policy({ components: new Set(['Note']), rawHtml: 'drop' })],
] as const;

const AFTER = '\n\nSECRET\n\nafter\n';

// Every page the security reviews of the chunk walker and of the hand written scanner reported,
// each with the word the render must decide on.
const REVIEWED: readonly (readonly [string, Dialect, string])[] = [
  ['inline script', 'md', 'Shown <script>SECRET_inline_script()</script> end.\n'],
  ['inline style', 'md', 'Shown <style>.SECRET-style{}</style> end.\n'],
  ['inline hidden', 'md', 'Shown <span hidden>SECRET-inline-hidden</span> end.\n'],
  ['display none', 'md', 'Shown <span style="display:none">SECRET-display-none</span> end.\n'],
  ['textarea', 'md', 'Shown <textarea>SECRET-textarea</textarea> end.\n'],
  ['hidden block split', 'md', '<div hidden>\n\nSECRET-block-hidden\n\n</div>\n'],
  ['template split', 'md', '<template>\n\nSECRET-template\n\n</template>\n'],
  ['noscript split', 'md', '<noscript>\n\nSECRET-noscript\n\n</noscript>\n'],
  ['hidden in a heading', 'md', '# Title <span hidden>SECRET-heading</span>\n\nWords.\n'],
  ['mdx script', 'mdx', '<script>SECRET-mdx-script</script>\n'],
  ['mdx hidden', 'mdx', '<div hidden>SECRET-mdx-hidden</div>\n'],
  ['mdx span', 'mdx', 'a <span hidden>SECRET-mdx-span</span> b\n'],
  ['mdx template', 'mdx', '<template>SECRET-tpl</template>\n'],
  ['unknown component', 'mdx', '<Foo>SECRET-unknown</Foo>\n'],
  ['fragment', 'mdx', '<>SECRET-frag</>\n'],
  ['orphan footnote', 'md', 'Words.\n\n[^9]: SECRET-orphan-footnote\n'],
  ['orphan footnote mdx', 'mdx', 'Words.\n\n[^9]: SECRET-orphan-footnote\n'],
  ['quote as attribute name, script', 'md', `<div '><script>'></div>${AFTER}`],
  ['quote as attribute name, template', 'md', `<div '><template>'></div>${AFTER}`],
  ['object scope', 'md', `<object><table></object>${AFTER}`],
  ['marquee scope', 'md', `<marquee><table></marquee>${AFTER}`],
  ['script double escape', 'md', `<script><!--<script></script>${AFTER}`],
  ['script double escape spaced', 'md', `<script><!-- <script> </script> x${AFTER}`],
  [
    'footnote first in a component',
    'mdx',
    'Ref[^a].\n\n<Foo>\n\n[^a]: shown\n\n</Foo>\n\n[^a]: SECRET\n',
  ],
  ['footnote first nested', 'md', 'Ref[^a].\n\n[^b]: x\n\n    [^a]: shown\n\n[^a]: SECRET\n'],
  ['frontmatter', 'md', '---\ntitle: SECRET-front\n---\n\nWords.\n'],
  ['comments', 'md', 'Words <!-- SECRET-inline --> here.\n\n<!-- SECRET-block -->\n'],
  ['link target', 'md', '[shown](https://SECRET-target.test "SECRET-title")\n'],
  ['image alt and target', 'md', '![SECRET-alt](https://SECRET-image.test)\n'],
  ['definition', 'md', '[a]: https://SECRET-definition.test\n\nWords.\n'],
  ['code info', 'md', '```ts SECRET-info\ncode\n```\n'],
  ['esm and expressions', 'mdx', "export const a = 'SECRET-esm'\n\nWords {'SECRET-expr'}.\n"],
  ['attribute', 'mdx', '<Note title="SECRET-attr">shown</Note>\n'],
];

describe('reader text', () => {
  it.each(POLICIES)(
    'holds no word the render does not show, on every reviewed page: %s',
    (_, use) => {
      for (const [name, dialect, source] of REVIEWED) {
        expect({ name, unseen: unseenWords(source, dialect, use) }).toEqual({ name, unseen: [] });
      }
    },
  );

  it('keeps an element with no text as a unit, so later units keep their numbers', () => {
    const before = unitsOf('A.\n\n<b></b>\n\nC.\n');
    const after = unitsOf('A.\n\n<b></b> words\n\nC.\n');
    expect(before.map(({ text }) => text)).toEqual(['A.', '', 'C.']);
    expect(after.map(({ text }) => text)).toEqual(['A.', ' words', 'C.']);
  });

  it('starts a unit at each top level element and marks headings with their depth', () => {
    expect(unitsOf('# One\n\nFirst.\n\n## Two\n\nSecond.\n')).toEqual([
      { heading: { depth: 1, text: 'One' }, text: 'One' },
      { text: 'First.' },
      { heading: { depth: 2, text: 'Two' }, text: 'Two' },
      { text: 'Second.' },
    ]);
  });

  it('reads heading text through inline marks and code', () => {
    expect(unitsOf('# Use **`saveDraft`** now\n')).toEqual([
      { heading: { depth: 1, text: 'Use saveDraft now' }, text: 'Use saveDraft now' },
    ]);
  });

  it('keeps a heading with no text, so it still starts a section', () => {
    expect(unitsOf('#\n\nWords.\n')).toEqual([
      { heading: { depth: 1, text: '' }, text: '' },
      { text: 'Words.' },
    ]);
  });

  it('keeps words in separate cells and items apart', () => {
    const [table, list] = unitsOf('| a | b |\n| --- | --- |\n| c | d |\n\n- one\n- two\n');
    expect(table?.text.split(/\s+/)).toEqual(['a', 'b', 'c', 'd']);
    expect(list?.text.split(/\s+/)).toEqual(['one', 'two']);
  });

  it('keeps the lines of a code block', () => {
    expect(unitsOf('```\nline one\n\n  line two\n```\n')).toEqual([
      { text: 'line one\n\n  line two' },
    ]);
  });

  it('gives the footnote section one unit, as it renders', () => {
    const units = unitsOf('Ref[^a].\n\n# Later\n\n[^a]: the note\n');
    expect(units.map(({ heading }) => heading?.text)).toEqual([undefined, 'Later', undefined]);
    expect(units.at(-1)?.text).toContain('the note');
  });

  it('reads a registered component and drops an unknown one with its children', () => {
    const use = policy({ components: new Set(['Note']) });
    const units = unitsOf('<Note>kept</Note>\n\n<Other>gone</Other>\n', 'mdx', use);
    expect(
      units
        .map(({ text }) => text)
        .join(' ')
        .trim(),
    ).toBe('kept');
  });

  it('gives a page of only frontmatter and comments no units', () => {
    expect(unitsOf('---\ntitle: a\n---\n\n<!-- b -->\n')).toEqual([]);
  });

  it('says a page the render refuses is not renderable, and holds no text for it', () => {
    const notes = 'Ref[^a]. '.repeat(2_001);
    expect(read(`${notes}\n\n[^a]: n\n`)).toEqual({ state: 'not_renderable' });
  });

  // The parse of 48,000 blocks is most of the time here, and under coverage on a shared runner it
  // passed the default 5 s once. The render's tag budget refuses before any walk.
  it(
    'refuses the hostile open tag page by its tag budget instead of walking it',
    () => {
      const page = `${'<a>\n\n'.repeat(24_000)}${'</b>\n\n'.repeat(24_000)}`;
      expect(read(page)).toEqual({ state: 'not_renderable' });
    },
    LARGE_PAGE_TIMEOUT_MS,
  );

  it('gives the same answer for the same tree', () => {
    const source = '# A\n\nText <b>bold</b>.\n\n| x |\n| - |\n| y |\n\nRef[^1].\n\n[^1]: n\n';
    expect(JSON.stringify(read(source))).toBe(JSON.stringify(read(source)));
  });

  it('grows with the page and not its square', () => {
    const page = (size: number) => '# H\n\nSome <em>words</em> here.\n\n'.repeat(size);
    const small = parsed(page(250), 'md');
    const large = parsed(page(1_000), 'md');
    expect(
      growthOf(
        () => readerPage(small, policy()),
        () => readerPage(large, policy()),
      ),
    ).toBeLessThan(MAX_GROWTH);
  });
});
