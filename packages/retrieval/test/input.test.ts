import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parsePageInput, parseRetrieveInput } from '../src/input.ts';

const NODE = '01890a5d-ac96-774b-bcce-b302099a0003';

describe('parseRetrieveInput', () => {
  it('fills the defaults', () => {
    expect(parseRetrieveInput({ query: 'install' })).toEqual({
      query: 'install',
      version: 'latest',
      limit: 8,
      pathPrefix: null,
    });
  });

  it('trims and normalizes the query to NFC', () => {
    const decomposed = 'café menu';
    const parsed = parseRetrieveInput({ query: `  ${decomposed}\n` });
    expect(parsed?.query).toBe('café menu');
  });

  it('counts the length cap in characters, after trimming', () => {
    expect(parseRetrieveInput({ query: 'a'.repeat(512) })).not.toBeNull();
    expect(parseRetrieveInput({ query: ` ${'a'.repeat(512)} ` })).not.toBeNull();
    expect(parseRetrieveInput({ query: 'a'.repeat(513) })).toBeNull();
    // 512 astral characters are 1,024 UTF-16 units and still one query.
    expect(parseRetrieveInput({ query: '\u{1F600}'.repeat(512) })).not.toBeNull();
    expect(parseRetrieveInput({ query: '\u{1F600}'.repeat(513) })).toBeNull();
  });

  it.each([
    [{}],
    [{ query: '' }],
    [{ query: '   ' }],
    [{ query: 7 }],
    [{ query: 'a', limit: 0 }],
    [{ query: 'a', limit: 21 }],
    [{ query: 'a', limit: 2.5 }],
    [{ query: 'a', limit: '8' }],
    [{ query: 'a', version: '' }],
    [{ query: 'a', version: 'v'.repeat(101) }],
    [{ query: 'a', pathPrefix: 'guides' }],
    [{ query: 'a', pathPrefix: `/${'g'.repeat(256)}` }],
    [{ query: 'a', extra: true }],
    [null],
    ['install'],
  ])('refuses %j', (input) => {
    expect(parseRetrieveInput(input)).toBeNull();
  });

  it('keeps a valid limit, version and prefix', () => {
    expect(
      parseRetrieveInput({ query: 'a', limit: 20, version: 'v2', pathPrefix: '/guides' }),
    ).toEqual({ query: 'a', limit: 20, version: 'v2', pathPrefix: '/guides' });
  });

  it('never throws, whatever it is given', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        expect(() => parseRetrieveInput(input)).not.toThrow();
      }),
    );
  });
});

describe('parsePageInput', () => {
  it('takes a path or a node id, and defaults the version', () => {
    expect(parsePageInput({ path: '/guides/install' })).toEqual({
      by: { path: '/guides/install' },
      version: 'latest',
    });
    expect(parsePageInput({ nodeId: NODE, version: 'latest' })).toEqual({
      by: { nodeId: NODE },
      version: 'latest',
    });
  });

  it.each([
    [{}],
    [{ path: '/a', nodeId: NODE }],
    [{ path: 'a' }],
    [{ path: `/${'p'.repeat(2048)}` }],
    [{ nodeId: 'nod_123' }],
    [{ nodeId: NODE.toUpperCase() }],
    [{ path: '/a', version: '' }],
    [{ path: '/a', other: 1 }],
    [undefined],
  ])('refuses %j', (input) => {
    expect(parsePageInput(input)).toBeNull();
  });
});
