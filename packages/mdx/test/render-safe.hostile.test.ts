import { describe, expect, it } from 'vitest';
import { RenderRefused, renderSafe } from '../src/render.ts';
import { MAX_GROWTH, SIZE_RATIO, cheapestCpuMs, growthOf } from './cost.ts';
import { policy } from './helpers.ts';
import { dangerIn, rendered, rerendered, rootOf, toHtml } from './render-helpers.ts';
import { MEASURED, OWASP } from './xss-payloads.ts';

// Only for a failing run. A passing one costs a fraction of this, and a timeout cannot stop a
// synchronous test anyway.
const GROWTH_TIMEOUT_MS = 180_000;
// Past each budget at both sizes, and small enough that with a budget removed the parser still
// finishes and this fails, and does not hang the run.
const REFUSED_SIZE = 15_000;
// Nodes. Four times this is near the 50,000 a page may hold.
const STORED_SIZE = 12_000;
// Elements, each two tags. Four times this is near the 5,000 tags a page may hold.
const RAW_SIZE = 600;
const MAX_FOOTNOTES = 2_000;
const MAX_LIST_ITEMS = 5_000;
const MAX_ATTRIBUTES = 9_900;
// A library is quadratic up to each of these budgets, so growth says nothing. CPU time at the
// budget does, and other work on the machine barely moves it.
const MAX_BUDGETED_CPU_MS = 3_000;

const codeOf = (html: string): unknown => {
  try {
    toHtml(rootOf([{ type: 'html', value: html }]));
  } catch (error) {
    return error instanceof RenderRefused ? error.code : error;
  }
  return 'rendered';
};

const allowAll = policy({ remoteImages: 'allow' });

// The page as written, as a block of raw HTML, in a sentence, as a link and an image target.
const placesFor = (payload: string): readonly string[] => [
  `${payload}\n`,
  `<div>${payload}</div>\n`,
  `text ${payload} text\n`,
  `> ${payload}\n`,
  `- ${payload}\n`,
  `| a |\n|---|\n| ${payload} |\n`,
  `[x](<${payload.replaceAll('>', '%3E').replaceAll('\n', ' ')}>)\n`,
  `![x](<${payload.replaceAll('>', '%3E').replaceAll('\n', ' ')}>)\n`,
];

describe.each([
  ['the measured payloads', MEASURED],
  ['the OWASP evasion list', OWASP],
])('%s', (_name, payloads) => {
  it.each(payloads.map((payload) => [payload]))('%s stays inert', (payload) => {
    for (const place of placesFor(payload)) {
      for (const dialect of ['md'] as const) {
        const html = rendered(place, dialect, allowAll);
        expect(dangerIn(html), place).toEqual([]);
        expect(rerendered(html, allowAll), place).toBe(html);
      }
    }
  });

  it('matches its golden output', async () => {
    const goldens = payloads.map((payload) => [payload, rendered(`${payload}\n`, 'md', allowAll)]);
    const name = payloads === MEASURED ? 'measured' : 'owasp';
    await expect(`${JSON.stringify(goldens, null, 1)}\n`).toMatchFileSnapshot(
      `fixtures/render/${name}.txt`,
    );
  });
});

describe('the measured payloads, one by one', () => {
  it('stores as an inline element in MDX and renders as nothing', () => {
    expect(rendered('<script>alert(1)</script>\n', 'mdx')).toBe('<p></p>');
  });

  it('keeps the image and loses the handler', () => {
    expect(rendered('<img src=x onerror=alert(1)>\n')).toBe('<img src="x" loading="lazy"/>');
  });

  it('keeps the link text and loses the target', () => {
    expect(rendered('[x](javascript:alert(1))\n')).toBe('<p><a>x</a></p>');
  });

  it('removes what the design record lists by name', () => {
    expect(
      rendered(
        '<form><input></form><iframe></iframe><object></object><embed><meta><base><link><svg></svg>x\n',
        'md',
      ),
    ).not.toMatch(/<(?:form|iframe|object|embed|meta|base|link|svg)/);
  });
});

const numbered = (total: number, each: (index: number) => string) =>
  Array.from({ length: total }, (_, index) => each(index)).join('');

const text = (value: string) => ({ type: 'paragraph', children: [{ type: 'text', value }] });

describe('work a page can force', { timeout: GROWTH_TIMEOUT_MS }, () => {
  const render = (html: string) => {
    codeOf(html);
  };

  // Past every limit, so these say what a refusal costs and that it is a refusal.
  it.each<[string, (size: number) => string]>([
    ['open elements', (size) => '<div>'.repeat(size)],
    ['table cells', (size) => '<table><tr><td>'.repeat(size)],
    ['formatting elements', (size) => '<b>'.repeat(size)],
    ['closing tags', (size) => '</b>'.repeat(size)],
    ['elements a parser compares', (size) => numbered(size, (i) => `<b a=${i}>`)],
    ['attributes in one tag', (size) => `<a ${numbered(size, (i) => `x${i.toString(36)} `)}>`],
    [
      'attributes split by slashes',
      (size) => `<a ${numbered(size, (i) => `x${i.toString(36)}/`)}>`,
    ],
    [
      'attributes with no spaces',
      (size) => `<a ${numbered(size, (i) => `x${i.toString(36)}=""`)}>`,
    ],
    [
      'formatting that reopens in every block',
      (size) => `${numbered(size, (i) => `<b a=${i}>`)}${'<p>'.repeat(size)}`,
    ],
  ])('refuses a page of %s at linear cost', (_name, page) => {
    const small = page(REFUSED_SIZE);
    const large = page(REFUSED_SIZE * SIZE_RATIO);
    expect(codeOf(small)).toBe('render.too_complex');
    expect(codeOf(large)).toBe('render.too_complex');
    expect(
      growthOf(
        () => {
          render(small);
        },
        () => {
          render(large);
        },
      ),
    ).toBeLessThan(MAX_GROWTH);
  });

  // Inside every limit, so these go all the way through and are what a stored page can cost.
  it.each<[string, (size: number) => unknown[]]>([
    ['paragraphs', (size) => Array.from({ length: size / 2 }, (_, i) => text(`p ${i}`))],
    [
      'one paragraph of inline nodes',
      (size) => [
        {
          type: 'paragraph',
          children: Array.from({ length: size / 2 }, () => ({
            type: 'emphasis',
            children: [{ type: 'text', value: 'x' }],
          })),
        },
      ],
    ],
    ['one long text', (size) => [text('word\n'.repeat(size))]],
    [
      'references and their definitions',
      (size) => [
        {
          type: 'paragraph',
          children: Array.from({ length: size / 2 }, (_, i) => ({
            type: 'linkReference',
            identifier: `r${i}`,
            referenceType: 'full',
            children: [],
          })),
        },
        ...Array.from({ length: size / 2 }, (_, i) => ({
          type: 'definition',
          identifier: `r${i}`,
          url: '/a',
        })),
      ],
    ],
    [
      'a wide table',
      (size) => [
        {
          type: 'table',
          children: [
            {
              type: 'tableRow',
              children: Array.from({ length: size / 2 }, () => ({
                type: 'tableCell',
                children: [{ type: 'text', value: 'x' }],
              })),
            },
          ],
        },
      ],
    ],
    [
      'images to check',
      (size) => [
        {
          type: 'paragraph',
          children: Array.from({ length: size }, () => ({ type: 'image', url: '/a.png' })),
        },
      ],
    ],
  ])('renders a stored page of %s at linear cost', (_name, children) => {
    const small = rootOf(children(STORED_SIZE));
    const large = rootOf(children(STORED_SIZE * SIZE_RATIO));
    expect(dangerIn(toHtml(small))).toEqual([]);
    expect(
      growthOf(
        () => toHtml(small),
        () => toHtml(large),
      ),
    ).toBeLessThan(MAX_GROWTH);
  });

  // The parser's budget, which is the most raw HTML a page can have and still render.
  it.each<[string, (size: number) => string]>([
    ['closed elements', (size) => '<div>x</div>'.repeat(size)],
    ['elements with attributes', (size) => '<span a="1">x</span>'.repeat(size)],
    [
      'formatting in table cells',
      (size) => `<table>${'<tr><td><b>x</b></td></tr>'.repeat(size / 12)}</table>`,
    ],
  ])('parses raw %s at no worse than the budget allows', (_name, page) => {
    const small = page(RAW_SIZE);
    const large = page(RAW_SIZE * SIZE_RATIO);
    expect(codeOf(small)).toBe('rendered');
    expect(codeOf(large)).toBe('rendered');
    expect(
      growthOf(
        () => {
          render(small);
        },
        () => {
          render(large);
        },
      ),
    ).toBeLessThan(MAX_GROWTH);
  });

  // Quadratic by nature, so what is held is the budget and not the growth.
  it('keeps one tag at its attribute budget cheap on the CPU', () => {
    const page = `<a ${numbered(MAX_ATTRIBUTES, (i) => `x${i.toString(36)} `)}>y</a>`;
    expect(codeOf(page)).toBe('rendered');
    expect(
      cheapestCpuMs(() => {
        render(page);
      }),
    ).toBeLessThan(MAX_BUDGETED_CPU_MS);
  });

  it('holds footnotes to a number their conversion can search', () => {
    const page = (total: number) =>
      rootOf([
        {
          type: 'paragraph',
          children: Array.from({ length: total }, (_, i) => ({
            type: 'footnoteReference',
            identifier: `n${i}`,
          })),
        },
        ...Array.from({ length: total }, (_, i) => ({
          type: 'footnoteDefinition',
          identifier: `n${i}`,
          children: [text('x')],
        })),
      ]);
    expect(cheapestCpuMs(() => renderSafe(page(MAX_FOOTNOTES), policy()))).toBeLessThan(
      MAX_BUDGETED_CPU_MS,
    );
    expect(() => renderSafe(page(MAX_FOOTNOTES + 1), policy())).toThrow(
      new RenderRefused('render.too_complex'),
    );
  });

  it('holds a list to a length its conversion can search', () => {
    const page = (total: number) =>
      rootOf([
        {
          type: 'list',
          children: Array.from({ length: total }, () => ({ type: 'listItem', children: [] })),
        },
      ]);
    expect(cheapestCpuMs(() => renderSafe(page(MAX_LIST_ITEMS), policy()))).toBeLessThan(
      MAX_BUDGETED_CPU_MS,
    );
    expect(() => renderSafe(page(MAX_LIST_ITEMS + 1), policy())).toThrow(
      new RenderRefused('render.too_complex'),
    );
  });

  // Only shows with coverage on, which is how the gate runs: without it the JIT makes a scan of
  // every item for every item look linear, until a cold process or a slow runner meets it.
  it(
    'searches a list once, not once for each item',
    () => {
      const page = (total: number) =>
        rootOf([
          {
            type: 'list',
            spread: false,
            children: Array.from({ length: total }, () => ({
              type: 'listItem',
              spread: false,
              children: [],
            })),
          },
        ]);
      expect(
        growthOf(
          () => renderSafe(page(MAX_LIST_ITEMS / SIZE_RATIO), policy()),
          () => renderSafe(page(MAX_LIST_ITEMS), policy()),
        ),
      ).toBeLessThan(MAX_GROWTH);
    },
    GROWTH_TIMEOUT_MS,
  );

  it('counts blocks outside the HTML against reopened formatting', () => {
    const paragraphs = Array.from({ length: 1_500 }, () => text('x'));
    const opening = numbered(1_500, (i) => `<b a=${i}>`);
    const tree = rootOf([{ type: 'html', value: opening }, ...paragraphs]);
    expect(() => renderSafe(tree, policy())).toThrow(new RenderRefused('render.too_complex'));
  });

  it('refuses nesting past the limit even when each tag closes in time', () => {
    expect(codeOf(`${'<div>'.repeat(300)}${'</div>'.repeat(300)}`)).toBe('render.too_deep');
  });

  it('turns a stack overflow in a library into a refusal', () => {
    // Too deep is the same answer from a process with a bigger stack.
    expect(codeOf('<div>'.repeat(4_900))).toMatch(/^render\.(?:failed|too_deep)$/);
  });

  it('turns a crash in a library into a refusal', () => {
    const tree = rootOf([
      {
        type: 'emphasis',
        children: [
          { type: 'emphasis', children: [{ type: 'html', value: '<?' }] },
          { type: 'html', value: ' ' },
        ],
      },
    ]);
    expect(() => renderSafe(tree, policy())).toThrow(new RenderRefused('render.failed'));
  });

  it('renders nesting inside the limit all the way through', () => {
    const page = `${'<div>'.repeat(60)}x${'</div>'.repeat(60)}`;
    expect(dangerIn(toHtml(rootOf([{ type: 'html', value: page }])))).toEqual([]);
  });

  it('renders at the ceiling of the depth limit', () => {
    let node: unknown = { type: 'text', value: 'x' };
    for (let level = 0; level < 505; level += 1) node = { type: 'emphasis', children: [node] };
    const use = policy({ limits: { maxBytes: 1_048_576, maxDepth: 512, maxNodes: 50_000 } });
    expect(toHtml(rootOf([{ type: 'paragraph', children: [node] }]), use)).toContain('x');
  });

  it('passes a large honest page of HTML', () => {
    const rows = Array.from({ length: 800 }, (_, i) => `<tr><td>${i}</td></tr>`).join('');
    expect(codeOf(`<table>${rows}</table>`)).toBe('rendered');
  });
});
