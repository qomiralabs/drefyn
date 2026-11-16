import { randomUUID } from 'node:crypto';
import { DEFAULT_LIMITS, type Dialect } from '@drefyn/mdx';
import { createParseClient } from '@drefyn/mdx/client';
import { organizationId, projectId } from '@drefyn/tenancy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chunkNode } from '../src/index.ts';
import { parseClientConfig, startHost, type RunningHost } from './support/parse-host.ts';

const options = { targetChars: 800, maxChars: 2000 };
const HOST_START_MS = 60_000;

const policy = {
  version: 1,
  components: new Set(['Note']),
  rawHtml: 'sanitize',
  remoteImages: 'proxy',
  linkProtocols: ['https', 'http', 'mailto'],
  limits: DEFAULT_LIMITS,
} as const;

const MD_PAGE = `---
title: frontmatter-secret
---

# Guide <!-- heading-comment-secret -->

Shown words <!-- inline-comment-secret --> and <span title="attr-secret">span shown</span>.

<!-- block-comment-secret -->

<div hidden>hidden attribute shown</div>

<script>script-secret()</script>

[link shown](https://link-target-secret.test "link-title-secret")

![image shown](https://image-target-secret.test "image-title-secret")

[reference shown][a]

[a]: https://definition-secret.test "definition-title-secret"

\`\`\`ts info-string-secret
code shown
\`\`\`

- list shown <!-- list-comment-secret -->

| head shown |
| --- |
| cell shown <!-- cell-comment-secret --> |

> quote shown

Footnote shown[^1].

[^1]: note shown <!-- footnote-comment-secret -->
`;

const MDX_PAGE = `import hidden from 'esm-secret'

export const secret = 'export-secret'

# Guide {'heading-expression-secret'}

Shown words {'inline-expression-secret'} and more.

{/* flow-comment-secret */}

{'flow-expression-secret'}

<Note title="attribute-secret">note shown</Note>
`;

const SHOWN = {
  md: [
    'Guide',
    'Shown words',
    'span shown',
    // The sanitizer drops the attribute, so a reader sees this text and so does a chunk.
    'hidden attribute shown',
    'link shown',
    'reference shown',
    'code shown',
    'list shown',
    'head shown',
    'cell shown',
    'quote shown',
    'note shown',
  ],
  mdx: ['Guide', 'Shown words', 'note shown'],
} as const;

const AFTER = '\n\nSECRET\n\nafter\n';

const HIDDEN_BY_THE_RENDER: readonly (readonly [string, Dialect, string])[] = [
  ['inline script', 'md', 'Shown <script>SECRET_inline_script()</script> end.\n'],
  ['inline style', 'md', 'Shown <style>.SECRET-style{}</style> end.\n'],
  ['textarea', 'md', 'Shown <textarea>SECRET-textarea</textarea> end.\n'],
  ['template split', 'md', '<template>\n\nSECRET-template\n\n</template>\n'],
  ['noscript split', 'md', '<noscript>\n\nSECRET-noscript\n\n</noscript>\n'],
  ['mdx script', 'mdx', '<script>SECRET-mdx-script</script>\n'],
  ['mdx hidden', 'mdx', '<div hidden>SECRET-mdx-hidden</div>\n'],
  ['mdx span', 'mdx', 'a <span hidden>SECRET-mdx-span</span> b\n'],
  ['mdx template', 'mdx', '<template>SECRET-tpl</template>\n'],
  ['unknown component', 'mdx', '<Foo>SECRET-unknown</Foo>\n'],
  ['fragment', 'mdx', '<>SECRET-frag</>\n'],
  ['orphan footnote', 'md', 'Words.\n\n[^9]: SECRET-orphan\n'],
  ['orphan footnote mdx', 'mdx', 'Words.\n\n[^9]: SECRET-orphan\n'],
  ['quote as attribute name, script', 'md', `<div '><script>'></div>${AFTER}`],
  ['quote as attribute name, template', 'md', `<div '><template>'></div>${AFTER}`],
  ['object scope', 'md', `<object><table></object>${AFTER}`],
  ['script double escape', 'md', `<script><!--<script></script>${AFTER}`],
  ['script double escape spaced', 'md', `<script><!-- <script> </script> x${AFTER}`],
  [
    'footnote first in a component',
    'mdx',
    'Ref[^a].\n\n<Foo>\n\n[^a]: shown\n\n</Foo>\n\n[^a]: SECRET\n',
  ],
  ['footnote first nested', 'md', 'Ref[^a].\n\n[^b]: x\n\n    [^a]: shown\n\n[^a]: SECRET\n'],
];

describe('a parsed page', () => {
  let running: RunningHost;

  const chunksOf = async (source: string, dialect: Dialect) => {
    const client = createParseClient(parseClientConfig(running.url));
    const tenant = {
      organizationId: organizationId(randomUUID()),
      projectId: projectId(randomUUID()),
    };
    const answer = await client.parse({
      tenant,
      path: 'page',
      source,
      dialect,
      policy,
      reader: true,
    });
    if (!answer.ok) throw new Error(answer.error.map(({ code }) => code).join(' '));
    const { reader } = answer.value;
    if (reader === undefined) throw new Error('no reader text');
    return chunkNode(reader, options);
  };

  // The first page loads the parser into a new thread, which is the host's start and not the
  // page's. Left to the first test, that cost lands on a test about something else.
  beforeAll(async () => {
    running = await startHost();
    await chunksOf('Warm.\n', 'md');
  }, HOST_START_MS);

  afterAll(() => {
    running.host.kill('SIGKILL');
  });

  it.each([
    ['md', MD_PAGE],
    ['mdx', MDX_PAGE],
  ] as const)('holds only what a reader sees: %s', async (dialect, source) => {
    const chunks = await chunksOf(source, dialect);
    const stored = JSON.stringify(chunks);
    expect(stored).not.toMatch(/secret/);
    for (const text of SHOWN[dialect]) expect(stored).toContain(text);
  });

  it('gives a page of nothing but comments and frontmatter no chunks', async () => {
    expect(await chunksOf('---\ntitle: a\n---\n\n<!-- b -->\n', 'md')).toEqual([]);
  });

  it('keeps a comment in a heading out of the heading path', async () => {
    const [chunk] = await chunksOf('# Guide <!-- secret -->\n\nWords.\n', 'md');
    expect(chunk?.headingPath).toEqual(['Guide ']);
  });

  // Every page from both security reviews of the chunk walker that the render does not show,
  // through the real host. The render's own tests prove reader text is a subset of it.
  it.each(HIDDEN_BY_THE_RENDER)(
    'keeps out what the render hides: %s',
    async (_name, dialect, source) => {
      const stored = JSON.stringify(await chunksOf(source, dialect));
      expect(stored).not.toContain('SECRET');
    },
  );

  it('stores no chunks for the hostile open tag page, and ends at once', async () => {
    const page = `${'<a>\n\n'.repeat(24_000)}${'</b>\n\n'.repeat(24_000)}`;
    const started = performance.now();
    expect(await chunksOf(page, 'md')).toEqual([]);
    // Refused by the render's tag budget in the host, before any walk. The engine has nothing to
    // walk, so its thread cannot stall on this page however slow the host is.
    expect(performance.now() - started).toBeLessThan(HOST_START_MS);
  });
});
