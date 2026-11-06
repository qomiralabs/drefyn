import { describe, expect, it } from 'vitest';
import { RenderRefused, renderSafe } from '../src/render.ts';
import type { RenderPolicy } from '../src/index.ts';
import { DEFAULT_LIMITS } from '../src/index.ts';
import { parsed, policy } from './helpers.ts';
import { dangerIn, rendered, rerendered, rootOf, toHtml } from './render-helpers.ts';

const refusal = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error instanceof RenderRefused ? error.code : error;
  }
  return 'rendered';
};

describe('renderSafe on plain content', () => {
  it('renders Markdown', () => {
    expect(rendered('# Hi\n\nSome *soft* and **bold** `code`.\n')).toBe(
      '<h1>Hi</h1>\n<p>Some <em>soft</em> and <strong>bold</strong> <code>code</code>.</p>',
    );
  });

  it('renders every shape the parser gives', () => {
    const html = rendered(
      [
        '> quote',
        '',
        '- a',
        '- [x] b',
        '',
        '3. c',
        '',
        '| x | y |',
        '|:--|--:|',
        '| 1 | 2 |',
        '',
        '```js',
        'let a',
        '```',
        '',
        '~~gone~~ ![alt](/a.png "t") [l](/b "t")',
        'line  ',
        'break',
        '',
        '---',
        '',
        'note[^1]',
        '',
        '[^1]: foot',
        '',
      ].join('\n'),
    );
    for (const part of [
      '<blockquote>',
      '<ol start="3">',
      '<td align="left">',
      '<code class="language-js">',
      '<del>gone</del>',
      '<img src="/a.png" alt="alt" title="t"/>',
      '<a href="/b" title="t">l</a>',
      '<br/>',
      '<hr/>',
      '<input type="checkbox" checked="" disabled=""/>',
      'data-footnote-ref',
      'id="user-content-fn-1"',
      'href="#user-content-fn-1"',
    ]) {
      expect(html).toContain(part);
    }
    expect(dangerIn(html)).toEqual([]);
  });

  it('gives the same bytes for the same tree', () => {
    const tree = parsed('# a\n\n<b id=x>y</b>\n\n[^1]\n\n[^1]: z\n', 'md');
    expect(toHtml(tree)).toBe(toHtml(tree));
  });

  it('renders an empty page', () => {
    expect(rendered('')).toBe('');
  });

  it('leaves the tree it was given alone', () => {
    const tree = parsed('<i id=x>y</i>\n', 'md');
    const before = JSON.stringify(tree);
    toHtml(tree);
    expect(JSON.stringify(tree)).toBe(before);
  });
});

describe('what is never run', () => {
  it('renders ESM and expressions as nothing', () => {
    const html = rendered(
      'import a from "b"\n\nexport const c = 1\n\n{alert(1)}\n\ntext {alert(2)} more\n',
      'mdx',
    );
    expect(html).toBe('<p>text  more</p>');
  });

  it('renders frontmatter as nothing', () => {
    expect(rendered('---\ntitle: a\n---\n\nbody\n')).toBe('<p>body</p>');
  });

  it('never reads an expression from a forged tree', () => {
    const tree = rootOf(
      [
        { type: 'mdxFlowExpression', value: 'globalThis.ran = true' },
        { type: 'mdxjsEsm', value: 'export default globalThis.ran = true' },
      ],
      'mdx',
    );
    expect(toHtml(tree)).toBe('');
    expect(globalThis).not.toHaveProperty('ran');
  });
});

describe('JSX', () => {
  const withNote = policy({ components: new Set(['Note']) });

  it('renders no element outside the registry, children included', () => {
    for (const name of ['script', 'img', 'iframe', 'div', 'Tabs', 'a.b', 'constructor']) {
      const source = `<${name} src="x" onError="alert(1)">hello</${name}>\n`;
      expect(rendered(source, 'mdx', withNote), name).toBe('');
    }
    expect(rendered('text <script>alert(1)</script> more\n', 'mdx')).toBe('<p>text  more</p>');
    expect(rendered('<>hello</>\n', 'mdx')).toBe('');
  });

  it('checks the registry by exact name', () => {
    expect(rendered('<note>hello</note>\n', 'mdx', withNote)).toBe('');
    expect(rendered('<NOTE>hello</NOTE>\n', 'mdx', withNote)).toBe('');
  });

  it('keeps the content of a registered name and none of its props', () => {
    const html = rendered(
      '<Note onClick="alert(1)" href="javascript:alert(1)" style="x" kind="a">\n\nhello *there*\n\n</Note>\n',
      'mdx',
      withNote,
    );
    expect(html).toContain('<p>hello <em>there</em></p>');
    expect(html).not.toMatch(/alert|style|kind/);
  });

  it('never evaluates a prop', () => {
    const tree = rootOf(
      [
        {
          type: 'mdxJsxFlowElement',
          name: 'Note',
          attributes: [
            {
              type: 'mdxJsxAttribute',
              name: 'a',
              value: { type: 'mdxJsxAttributeValueExpression', value: 'globalThis.ran = true' },
            },
            { type: 'mdxJsxExpressionAttribute', value: '...(globalThis.ran = true)' },
          ],
          children: [{ type: 'paragraph', children: [{ type: 'text', value: 'x' }] }],
        },
      ],
      'mdx',
    );
    expect(toHtml(tree, withNote)).toBe('<p>x</p>');
    expect(globalThis).not.toHaveProperty('ran');
  });
});

describe('raw HTML', () => {
  it('keeps what the allow list holds', () => {
    expect(rendered('<details open><summary>a</summary>b</details>\n')).toBe(
      '<details open=""><summary>a</summary>b</details>',
    );
    expect(rendered('<sub>a</sub> and <kbd>b</kbd>\n')).toBe(
      '<p><sub>a</sub> and <kbd>b</kbd></p>',
    );
  });

  it('joins a tag across text', () => {
    expect(rendered('a <b>b *c*</b>\n')).toBe('<p>a <b>b <em>c</em></b></p>');
  });

  it('drops script and style with their text, and unwraps other unknown tags', () => {
    expect(rendered('<div><script>a()</script><style>b{}</style><custom>c</custom></div>\n')).toBe(
      '<div>c</div>',
    );
  });

  it('drops comments, doctypes and processing instructions', () => {
    expect(rendered('<!-- a -->\n\n<!doctype html>\n\n<?php b ?>\n')).toBe('');
  });

  it('is gone under the drop policy', () => {
    const use = policy({ rawHtml: 'drop' });
    expect(rendered('<div>a</div>\n\nb <i>c</i>\n\n<script>d()</script>\n', 'md', use)).toBe(
      '<p>b c</p>',
    );
  });

  it('holds every attribute to the list of its element', () => {
    const html = rendered(
      '<p onclick="a()" style="color:red" class="x" data-x="1" contenteditable align="left">a</p>\n',
    );
    expect(html).toBe('<p align="left">a</p>');
  });

  it('makes any input a disabled checkbox', () => {
    expect(rendered('<input type=password value=a name=b>\n')).toBe(
      '<input type="checkbox" disabled=""/>',
    );
  });

  it('keeps only language classes on code', () => {
    expect(rendered('<code class="language-js evil">a</code>\n')).toBe(
      '<p><code class="language-js">a</code></p>',
    );
  });

  it('normalizes carriage returns, which a browser would', () => {
    const html = toHtml(
      rootOf([
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'a\r\nb\rc' },
            { type: 'image', url: '/a', alt: 'd\re' },
          ],
        },
      ]),
    );
    expect(html).toBe('<p>a\nb\nc<img src="/a" alt="d\ne"/></p>');
  });
});

describe('DOM clobbering', () => {
  it('prefixes id and name', () => {
    expect(rendered('<a id="forms" name="body">x</a>\n')).toBe(
      '<p><a id="user-content-forms" name="user-content-body">x</a></p>',
    );
    expect(rendered('<h2 id="intro">x</h2>\n')).toBe('<h2 id="user-content-intro">x</h2>');
  });

  it('prefixes once however many renders it goes through', () => {
    const once = rendered('<a id="x" name="user-content-user-content-y">x</a>\n');
    expect(once).toBe('<p><a id="user-content-x" name="user-content-y">x</a></p>');
    expect(rerendered(once)).toBe(once);
  });

  it('prefixes id lists', () => {
    expect(rendered('<a aria-describedby="a b" aria-labelledby="c">x</a>\n')).toBe(
      '<p><a aria-describedby="user-content-a user-content-b" aria-labelledby="user-content-c">x</a></p>',
    );
  });

  it('drops name where it can clobber a form or document property', () => {
    expect(rendered('<img name="getElementById" src="/a">\n')).toBe('<p><img src="/a"/></p>');
  });
});

describe('URLs', () => {
  const href = (url: string, use = policy()) =>
    toHtml(rootOf([{ type: 'paragraph', children: [{ type: 'link', url, children: [] }] }]), use);
  const src = (url: string, use = policy()) =>
    toHtml(rootOf([{ type: 'paragraph', children: [{ type: 'image', url }] }]), use);

  it.each([
    'https://a.example/b',
    'http://a.example/b',
    'HTTPS://a.example/b',
    'mailto:a@example.com',
    '/b',
    'b/c:d',
    '../b',
    '?a:b',
    '#a:b',
  ])('keeps %s on a link', (url) => {
    expect(href(url)).toContain(' href=');
  });

  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    '\u0001javascript:alert(1)',
    'vbscript:a',
    'data:text/html,a',
    'file:///etc/passwd',
    'blob:https://a.example/b',
    'tel:1',
    'ftp://a.example',
    ':a',
  ])('drops %j from a link', (url) => {
    const html = href(url);
    expect(html).toBe('<p><a></a></p>');
  });

  it('follows the policy for links', () => {
    expect(href('http://a.example', policy({ linkProtocols: ['https'] }))).toBe('<p><a></a></p>');
    expect(href('mailto:a@b', policy({ linkProtocols: ['https'] }))).toBe('<p><a></a></p>');
  });

  it('treats an empty list as no scheme, where the sanitizer would read it as any', () => {
    const use = policy({ linkProtocols: [] });
    expect(href('javascript:alert(1)', use)).toBe('<p><a></a></p>');
    expect(href('https://a.example', use)).toBe('<p><a></a></p>');
    expect(href('/b', use)).toBe('<p><a href="/b"></a></p>');
  });

  it('applies through references too', () => {
    expect(rendered('[x][r]\n\n[r]: javascript:alert(1)\n')).toBe('<p><a>x</a></p>');
    expect(rendered('![x][r]\n\n[r]: javascript:alert(1)\n')).toBe('<p><img alt="x"/></p>');
  });

  it('never gives an image a mail link or a script', () => {
    const allow = policy({ remoteImages: 'allow' });
    expect(src('mailto:a@b', allow)).toBe('<p><img/></p>');
    expect(src('javascript:alert(1)', allow)).toBe('<p><img/></p>');
    expect(src('data:image/png;base64,AAAA', allow)).toBe('<p><img/></p>');
  });

  it('loads remote images only when the policy says so', () => {
    const allow = policy({ remoteImages: 'allow' });
    expect(src('https://a.example/b.png', allow)).toContain('src=');
    expect(src('http://a.example/b.png', allow)).toContain('src=');
    expect(src('/b.png', allow)).toContain('src=');
    for (const mode of ['block', 'proxy'] as const) {
      const use = policy({ remoteImages: mode });
      expect(src('/b.png', use)).toContain('src=');
      expect(src('b.png', use)).toContain('src=');
    }
  });

  it.each([
    'https://a.example/b.png',
    'http://a.example/b.png',
    '//a.example/b.png',
    '/\\a.example/b.png',
    '\\\\a.example/b.png',
    '\t//a.example/b.png',
    '/\t/a.example/b.png',
    'https:a.example/b.png',
    'http://[',
  ])('takes %j off an image unless remote images are allowed', (url) => {
    for (const mode of ['block', 'proxy'] as const) {
      const use = policy({ remoteImages: mode });
      expect(src(url, use), mode).toBe('<p><img/></p>');
      const raw = rendered(`<img src="${url}">\n`, 'md', use);
      expect(raw, mode).toBe('<p><img/></p>');
    }
  });

  it('drops an empty src, which a browser would resolve to the page', () => {
    expect(src('')).toBe('<p><img/></p>');
  });
});

describe('refusals', () => {
  it('refuses a policy outside its schema', () => {
    const bad = { ...policy(), linkProtocols: ['javascript'] } as unknown as RenderPolicy;
    expect(refusal(() => renderSafe(rootOf([]), bad))).toBe('render.invalid_policy');
  });

  it.each([
    ['not a tree', null],
    ['a string', '<script>'],
    ['an unknown node', rootOf([{ type: 'script', value: 'x' }])],
    ['a data field', rootOf([{ type: 'paragraph', children: [], data: { hName: 'script' } }])],
    ['a wrong version', { ...rootOf([]), astVersion: 2 }],
    [
      'a hostile data field deep down',
      rootOf([
        {
          type: 'paragraph',
          children: [
            {
              type: 'emphasis',
              children: [],
              data: { hProperties: { onClick: 'alert(1)' } },
            },
          ],
        },
      ]),
    ],
  ])('refuses %s', (_name, value) => {
    expect(refusal(() => renderSafe(value as never, policy()))).toBe('render.invalid_tree');
  });

  it('refuses a tree past the depth limit of the policy', () => {
    let node: unknown = { type: 'text', value: 'x' };
    for (let level = 0; level < 20; level += 1) node = { type: 'emphasis', children: [node] };
    const use = policy({ limits: { ...DEFAULT_LIMITS, maxDepth: 10 } });
    expect(refusal(() => renderSafe(rootOf([node]), use))).toBe('render.invalid_tree');
  });

  it('holds a tree far larger than its source, as a stored one is', () => {
    const page = Array.from({ length: 2000 }, (_, index) => `line ${index}\n`).join('\n');
    const tree = parsed(page, 'md');
    const tight = policy({ limits: { ...DEFAULT_LIMITS, maxBytes: 20_000 } });
    expect(toHtml(tree, tight)).toContain('line 1999');
  });

  it('says nothing of the page in its message', () => {
    const tree = rootOf([{ type: 'html', value: '<div>'.repeat(20_000) }]);
    try {
      renderSafe(tree, policy());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RenderRefused);
      expect((error as Error).message).not.toContain('div');
    }
  });
});
