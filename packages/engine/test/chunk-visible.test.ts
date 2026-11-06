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

Shown words <!-- inline-comment-secret --> and <span title="attr-secret">span-secret</span>.

<!-- block-comment-secret -->

<div hidden>raw-html-secret</div>

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
    'link shown',
    'image shown',
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

// Each hides text from a reader, or may, so none of its text may be chunked. Whatever the page
// does around it, the last line is plain text and has to survive unless a tag was left open.
const RAW_HTML_PAGES = [
  'Shown <script>secret_inline_script()</script> end.',
  'Shown <style>.secret-style{}</style> end.',
  'Shown <span hidden>secret-inline-hidden</span> end.',
  'Shown <span style="display:none">secret-display-none</span> end.',
  'Shown <textarea>secret-textarea</textarea> end.',
  '<div hidden>\n\nsecret-block-hidden\n\n</div>',
  '<template>\n\nsecret-template\n\n</template>',
  '<noscript>\n\nsecret-noscript\n\n</noscript>',
  '# Title <span hidden>secret-heading</span>',
  '# Title <script>secret-heading()</script>',
  'Shown <b><style></b>secret-sticky</style> end.',
  'Shown <div><template></div>secret-template-sticky</template> end.',
  'Shown <script title="></script>">secret-quoted-close</script> end.',
  'Shown <TEMPLATE>secret-upper-case</TEMPLATE> end.',
  'Open <template>\n\nsecret-next-block',
  '<style>\n\n</style> secret-close-in-a-paragraph',
  '<noscript><span>\n\n| secret | cell |\n</noscript>\n\nsecret-after',
] as const;

const MDX_HIDDEN_PAGES = [
  '<script>secret-mdx-script</script>',
  '<div hidden>secret-mdx-hidden</div>',
  'a <span hidden>secret-mdx-span</span> b',
  '<template>secret-tpl</template>',
  '<Foo>secret-unknown</Foo>',
  '<>secret-frag</>',
  '<Foo><Note>secret-note-in-unknown</Note></Foo>',
] as const;

const FOOTNOTE_PAGES = [
  'Words.\n\n[^9]: secret-orphan-footnote',
  'Words[^1].\n\n[^1]: First.\n\n[^1]: secret-duplicate-footnote',
  'Words <template>[^1]</template>.\n\n[^1]: secret-hidden-reference',
  'Words[^1].\n\n[^1]: Shown.\n\n[^2]: secret-unreferenced\n',
  'Words[^1]. <template>\n\n[^1]: secret-footnote-rendered-inside-template',
  'Words[^1][^2].\n\n[^2]: secret-rendered-after <template>\n\n[^1]: Shown\n',
] as const;

describe('a parsed page', () => {
  let running: RunningHost;

  const chunksOf = async (source: string, dialect: Dialect) => {
    const client = createParseClient(parseClientConfig(running.url));
    const tenant = {
      organizationId: organizationId(randomUUID()),
      projectId: projectId(randomUUID()),
    };
    const answer = await client.parse({ tenant, path: 'page', source, dialect, policy });
    if (!answer.ok) throw new Error(answer.error.map(({ code }) => code).join(' '));
    return chunkNode(answer.value.ast, { ...options, components: policy.components });
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

  it.each(RAW_HTML_PAGES)('keeps raw HTML content out: %j', async (source) => {
    expect(JSON.stringify(await chunksOf(source, 'md'))).not.toMatch(/secret/i);
  });

  it.each(MDX_HIDDEN_PAGES)('keeps what renders as nothing out: %j', async (source) => {
    expect(JSON.stringify(await chunksOf(source, 'mdx'))).not.toContain('secret');
  });

  it.each(FOOTNOTE_PAGES)('keeps a footnote no reader gets out: %j', async (source) => {
    expect(JSON.stringify(await chunksOf(source, 'md'))).not.toContain('secret');
  });

  it('keeps cells past the header, which render as nothing', async () => {
    const page = '| a |\n| - |\n| b | secret-extra-cell |\n';
    const stored = JSON.stringify(await chunksOf(page, 'md'));
    expect(stored).toContain('b');
    expect(stored).not.toContain('secret');
  });

  it('reads on after a closed tag and past a void one', async () => {
    const page = 'One <br> two <b>three</b> four.\n\nAfter.\n';
    const [chunk] = await chunksOf(page, 'md');
    expect(chunk?.body).toContain('One');
    expect(chunk?.body).toContain('two');
    expect(chunk?.body).toContain('four.');
    expect(chunk?.body).toContain('After.');
  });

  it('keeps the children of a registered component, whatever its props say', async () => {
    const [chunk] = await chunksOf('<Note hidden="x">shown child</Note>\n', 'mdx');
    expect(chunk?.body).toBe('shown child');
  });

  it('keeps a referenced footnote', async () => {
    const stored = JSON.stringify(await chunksOf('Words[^1].\n\n[^1]: Note text.\n', 'md'));
    expect(stored).toContain('Note text.');
  });

  it('gives a page of nothing but comments and frontmatter no chunks', async () => {
    expect(await chunksOf('---\ntitle: a\n---\n\n<!-- b -->\n', 'md')).toEqual([]);
  });

  it('keeps a comment in a heading out of the heading path', async () => {
    const [chunk] = await chunksOf('# Guide <!-- secret -->\n\nWords.\n', 'md');
    expect(chunk?.headingPath).toEqual(['Guide ']);
  });
});
