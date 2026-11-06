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
    'span shown',
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

describe('a parsed page', () => {
  let running: RunningHost;

  beforeAll(async () => {
    running = await startHost();
  }, HOST_START_MS);

  afterAll(() => {
    running.host.kill('SIGKILL');
  });

  const chunksOf = async (source: string, dialect: Dialect) => {
    const client = createParseClient(parseClientConfig(running.url));
    const tenant = {
      organizationId: organizationId(randomUUID()),
      projectId: projectId(randomUUID()),
    };
    const answer = await client.parse({ tenant, path: 'page', source, dialect, policy });
    if (!answer.ok) throw new Error(answer.error.map(({ code }) => code).join(' '));
    return chunkNode(answer.value.ast, options);
  };

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
});
