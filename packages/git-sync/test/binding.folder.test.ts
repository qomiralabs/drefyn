import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FOLDER_MAX_CHARS, isPathInFolder, parseFolder } from '../src/index.ts';

const unsafe = { ok: false, error: 'git_sync.folder_unsafe' };

describe('parseFolder', () => {
  it.each(['', 'docs', 'docs/guide', 'a.b/c-d_e', '.github-pages/x', 'x'.repeat(FOLDER_MAX_CHARS)])(
    'accepts %j as written',
    (folder) => {
      expect(parseFolder(folder)).toEqual({ ok: true, value: folder });
    },
  );

  it.each([
    '/',
    '/docs',
    'docs/',
    'a//b',
    '.',
    '..',
    '../docs',
    'docs/..',
    'a/../b',
    'a/./b',
    './docs',
    'a\\b',
    'docs\u0000',
    'do\ncs',
    'x'.repeat(FOLDER_MAX_CHARS + 1),
  ])('refuses %j with a stable code', (folder) => {
    expect(parseFolder(folder)).toEqual(unsafe);
  });

  it.each([undefined, null, 1, {}, ['docs']])('refuses the non string %j', (folder) => {
    expect(parseFolder(folder)).toEqual(unsafe);
  });

  it('never accepts a folder with a dot dot segment or a leading slash', () => {
    const segment = fc.constantFrom('a', 'b', '..', '.', '', 'docs');
    fc.assert(
      fc.property(
        fc.array(segment, { minLength: 1, maxLength: 6 }),
        fc.boolean(),
        (parts, lead) => {
          const folder = `${lead ? '/' : ''}${parts.join('/')}`;
          const result = parseFolder(folder);
          if (result.ok && folder !== '') {
            expect(folder.startsWith('/')).toBe(false);
            expect(folder.split('/')).not.toContain('..');
            expect(folder.split('/')).not.toContain('');
          }
        },
      ),
    );
  });
});

describe('isPathInFolder', () => {
  it('takes any safe path for the repository root', () => {
    expect(isPathInFolder('a.mdx', '')).toBe(true);
    expect(isPathInFolder('docs/a.mdx', '')).toBe(true);
  });

  it('takes paths under the folder only', () => {
    expect(isPathInFolder('docs/a.mdx', 'docs')).toBe(true);
    expect(isPathInFolder('docs/x/a.mdx', 'docs')).toBe(true);
    expect(isPathInFolder('docsy/a.mdx', 'docs')).toBe(false);
    expect(isPathInFolder('docs', 'docs')).toBe(false);
  });

  it.each(['', '/a.mdx', 'docs/../a.mdx', 'docs//a.mdx', 'docs/./a.mdx', 'x'.repeat(4097)])(
    'refuses the unsafe path %j',
    (path) => {
      expect(isPathInFolder(path, '')).toBe(false);
    },
  );
});
