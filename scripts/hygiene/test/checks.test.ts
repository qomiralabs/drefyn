import { describe, expect, it } from 'vitest';
import {
  checkFileContent,
  checkMessage,
  checkPath,
  findDashes,
  formatFinding,
  isBinary,
  isInternalPath,
} from '../src/checks.ts';
import { CO_AUTHOR, EM_DASH, EN_DASH } from './helpers.ts';

const utf8 = (text: string) => new TextEncoder().encode(text);

describe('findDashes', () => {
  it('returns nothing for clean text, including plain hyphens and minus signs', () => {
    expect(findDashes('a - b -- c --- d, x-y, 3 - 2')).toEqual([]);
  });

  it('finds an en dash and an em dash with line and column', () => {
    expect(findDashes(`first line\nsecond ${EN_DASH} here\n${EM_DASH}`)).toEqual([
      { line: 2, column: 8, codePoint: 'U+2013' },
      { line: 3, column: 1, codePoint: 'U+2014' },
    ]);
  });

  it('counts columns in code points so astral characters do not shift them', () => {
    expect(findDashes(`\u{1F600}${EM_DASH}`)).toEqual([
      { line: 1, column: 2, codePoint: 'U+2014' },
    ]);
  });

  it('treats CRLF line endings as one break', () => {
    expect(findDashes(`a\r\nb\r\n${EN_DASH}`)).toEqual([
      { line: 3, column: 1, codePoint: 'U+2013' },
    ]);
  });

  it('ignores escaped forms that are not the character itself', () => {
    expect(findDashes('\\u2014 &mdash; &#8212; %E2%80%94')).toEqual([]);
  });
});

describe('isBinary', () => {
  it('treats text as text', () => {
    expect(isBinary(utf8('hello'))).toBe(false);
  });

  it('treats a NUL byte near the start as binary', () => {
    expect(isBinary(new Uint8Array([0x89, 0x50, 0x00, 0x47]))).toBe(true);
  });

  it('only looks at the first 8000 bytes, like git', () => {
    const late = new Uint8Array(9000).fill(0x61);
    late[8500] = 0;
    expect(isBinary(late)).toBe(false);
  });

  it('treats an empty file as text', () => {
    expect(isBinary(new Uint8Array())).toBe(false);
  });
});

describe('checkFileContent', () => {
  it('passes clean text', () => {
    expect(checkFileContent('README.md', utf8('# Title\n\nAll good - really.\n'))).toEqual([]);
  });

  it('flags a dash inside a fenced code block', () => {
    const md = ['# Notes', '', '```ts', `const range = '1${EN_DASH}5';`, '```', ''].join('\n');
    expect(checkFileContent('docs/notes.md', utf8(md))).toEqual([
      {
        rule: 'dash',
        source: 'docs/notes.md',
        line: 4,
        column: 17,
        detail: 'U+2013 en dash',
      },
    ]);
  });

  it('flags a dash far past the binary sniffing window', () => {
    const text = 'a'.repeat(10_000) + EM_DASH;
    expect(checkFileContent('big.txt', utf8(text))).toHaveLength(1);
  });

  it('skips binary content even when it holds dash bytes', () => {
    const bytes = new Uint8Array([0x00, 0xe2, 0x80, 0x94]);
    expect(checkFileContent('image.png', bytes)).toEqual([]);
  });
});

describe('isInternalPath', () => {
  it.each([
    '.internal/notes.md',
    'packages/x/.internal/a.md',
    'implementation.md',
    'apps/web/implementation.md',
    'IMPLEMENTATION.md',
    'Implementation.md',
    'CLAUDE.md',
    'packages/x/claude.md',
    '.claude/settings.json',
    'apps/web/.claude/hooks/x.sh',
    'docs/internal/plan.md',
    'apps/docs/docs/internal/plan.md',
    'roadmap.internal.md',
    'docs/Plan.INTERNAL.md',
  ])('flags %s', (path) => {
    expect(isInternalPath(path)).toBe(true);
  });

  it.each([
    'README.md',
    'docs/internals.md',
    'docs/internal.md',
    'internal/README.md',
    'src/claude.ts',
    'src/implementation.ts',
    'my-implementation.md',
    'not.claude/x',
    'docs/internally/x.md',
    'x.internal.mdx',
  ])('allows %s', (path) => {
    expect(isInternalPath(path)).toBe(false);
  });
});

describe('checkPath', () => {
  it('passes a normal path', () => {
    expect(checkPath('src/index.ts')).toEqual([]);
  });

  it('flags an internal path', () => {
    expect(checkPath('docs/internal/plan.md')).toEqual([
      {
        rule: 'internal-path',
        source: 'docs/internal/plan.md',
        detail: 'internal files must not be tracked',
      },
    ]);
  });

  it('flags a dash in a file name', () => {
    expect(checkPath(`notes/a${EM_DASH}b.md`)).toEqual([
      {
        rule: 'dash',
        source: `notes/a${EM_DASH}b.md`,
        detail: 'U+2014 em dash in the file name',
      },
    ]);
  });
});

describe('checkMessage', () => {
  it('passes a clean commit message', () => {
    const msg = 'feat(status): require two regions\n\nOne region can flap on its own.\n';
    expect(checkMessage('commit abc', msg)).toEqual([]);
  });

  it.each([
    `${CO_AUTHOR}: Someone <someone@example.com>`,
    `${CO_AUTHOR.toLowerCase()}: someone <s@example.com>`,
    `${CO_AUTHOR.toUpperCase()}: SOMEONE <S@EXAMPLE.COM>`,
    `  ${CO_AUTHOR}: indented <s@example.com>`,
    `${CO_AUTHOR} : spaced colon <s@example.com>`,
    `${CO_AUTHOR.replace('-', String.fromCodePoint(0x2011))}: odd hyphen <s@example.com>`,
  ])('flags the trailer variant %j', (trailer) => {
    const findings = checkMessage('commit abc', `fix: thing\n\nWhy.\n\n${trailer}\n`);
    expect(findings.map((f) => f.rule)).toContain('co-author');
    expect(findings.find((f) => f.rule === 'co-author')?.line).toBe(5);
  });

  it('does not flag a mention of co-authors in prose', () => {
    expect(checkMessage('pr body', 'We thank all co-authors of the spec.')).toEqual([]);
  });

  it.each(['Generated with SomeTool', '  generated   with a bot', 'Docs GENERATED WITH x'])(
    'flags the generated line %j',
    (line) => {
      const findings = checkMessage('commit abc', `chore: x\n\n${line}\n`);
      expect(findings).toEqual([
        {
          rule: 'generated-with',
          source: 'commit abc',
          line: 3,
          detail: 'attribution line ("Generated with")',
        },
      ]);
    },
  );

  it('flags dashes in a message with positions', () => {
    expect(checkMessage('pr title', `fix: a ${EM_DASH} b`)).toEqual([
      { rule: 'dash', source: 'pr title', line: 1, column: 8, detail: 'U+2014 em dash' },
    ]);
  });

  it('reports every problem in one message', () => {
    const msg = `fix: x ${EN_DASH} y\n\nGenerated with Tool\n${CO_AUTHOR}: a <a@b.c>\n`;
    expect(checkMessage('commit abc', msg).map((f) => f.rule)).toEqual([
      'dash',
      'generated-with',
      'co-author',
    ]);
  });
});

describe('formatFinding', () => {
  it('includes line and column when known', () => {
    expect(
      formatFinding({ rule: 'dash', source: 'a.md', line: 2, column: 3, detail: 'U+2013 en dash' }),
    ).toBe('a.md:2:3: dash: U+2013 en dash');
  });

  it('includes only the line when there is no column', () => {
    expect(formatFinding({ rule: 'co-author', source: 'commit x', line: 4, detail: 'd' })).toBe(
      'commit x:4: co-author: d',
    );
  });

  it('prints only the source when there is no position', () => {
    expect(formatFinding({ rule: 'internal-path', source: 'CLAUDE.md', detail: 'd' })).toBe(
      'CLAUDE.md: internal-path: d',
    );
  });
});
