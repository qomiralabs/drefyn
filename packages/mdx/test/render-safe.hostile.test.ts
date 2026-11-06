import { describe, expect, it } from 'vitest';
import { RenderRefused, renderSafe } from '../src/render.ts';
import { policy } from './helpers.ts';
import { dangerIn, rendered, rerendered, rootOf, toHtml } from './render-helpers.ts';
import { MEASURED, OWASP } from './xss-payloads.ts';

// Far above a fair run on a loaded machine, and far below a parser left to run: this catches a
// hang and is no benchmark.
const BUDGET_MS = 20_000;

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

describe('work a page can force', { timeout: 2 * BUDGET_MS }, () => {
  const timed = (html: string): unknown => {
    const started = performance.now();
    const code = codeOf(html);
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
    return code;
  };

  it.each([
    ['open elements', '<div>'.repeat(200_000)],
    ['table cells', '<table><tr><td>'.repeat(60_000)],
    ['formatting elements', '<b>'.repeat(200_000)],
    ['closing tags', '</b>'.repeat(200_000)],
    ['elements a parser compares', Array.from({ length: 60_000 }, (_, i) => `<b a=${i}>`).join('')],
  ])('refuses a page of %s', (_name, html) => {
    expect(timed(html)).toBe('render.too_complex');
  });

  it('refuses a page whose formatting reopens in every block', () => {
    const page = `${Array.from({ length: 2_000 }, (_, i) => `<b a=${i}>`).join('')}${'<p>'.repeat(2_000)}`;
    expect(timed(page)).toBe('render.too_complex');
  });

  it('counts blocks outside the HTML against reopened formatting', () => {
    const paragraphs = Array.from({ length: 1_500 }, () => ({
      type: 'paragraph',
      children: [{ type: 'text', value: 'x' }],
    }));
    const opening = Array.from({ length: 1_500 }, (_, i) => `<b a=${i}>`).join('');
    const tree = rootOf([{ type: 'html', value: opening }, ...paragraphs]);
    expect(() => renderSafe(tree, policy())).toThrow(RenderRefused);
  });

  it('refuses one tag with a quadratic number of attributes', () => {
    const attributes = Array.from({ length: 200_000 }, (_, i) => `x${i.toString(36)}`).join(' ');
    expect(timed(`<a ${attributes}>`)).toBe('render.too_complex');
  });

  it('refuses attributes packed without spaces', () => {
    const attributes = Array.from({ length: 200_000 }, (_, i) => `x${i.toString(36)}`).join('/');
    expect(timed(`<a ${attributes}>`)).toBe('render.too_complex');
    const quoted = Array.from({ length: 200_000 }, (_, i) => `x${i.toString(36)}=""`).join('');
    expect(timed(`<a ${quoted}>`)).toBe('render.too_complex');
  });

  it('refuses nesting past the limit even when each tag closes in time', () => {
    expect(timed(`${'<div>'.repeat(300)}${'</div>'.repeat(300)}`)).toBe('render.too_deep');
  });

  it('turns a stack overflow in a library into a refusal', () => {
    // Too deep is the same answer from a process with a bigger stack.
    expect(timed('<div>'.repeat(4_900))).toMatch(/^render\.(?:failed|too_deep)$/);
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

  it('holds on footnotes, which the Markdown conversion searches in a list', () => {
    const total = 24_000;
    const paragraph = {
      type: 'paragraph',
      children: Array.from({ length: total }, (_, i) => ({
        type: 'footnoteReference',
        identifier: `n${i}`,
      })),
    };
    const notes = Array.from({ length: total }, (_, i) => ({
      type: 'footnoteDefinition',
      identifier: `n${i}`,
      children: [],
    }));
    const started = performance.now();
    toHtml(rootOf([paragraph, ...notes]));
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  });

  it('passes a large honest page of HTML', () => {
    const rows = Array.from({ length: 800 }, (_, i) => `<tr><td>${i}</td></tr>`).join('');
    expect(codeOf(`<table>${rows}</table>`)).toBe('rendered');
  });
});
