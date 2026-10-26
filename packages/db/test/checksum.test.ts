import { describe, expect, it } from 'vitest';
import { sha256Hex, verifyChecksums } from '../src/checksum.ts';
import { utf8 } from './support.ts';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

describe('sha256Hex', () => {
  it('matches the published test vectors', () => {
    expect(sha256Hex(utf8(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(utf8('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is lower case hex, 64 characters', () => {
    expect(sha256Hex(utf8('select 1;'))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('verifyChecksums', () => {
  it('finds nothing when every applied file is unchanged', () => {
    expect(
      verifyChecksums(
        [
          { name: '1_a.sql', sha256: A },
          { name: '2_b.sql', sha256: B },
        ],
        [
          { name: '1_a.sql', sha256: A },
          { name: '2_b.sql', sha256: B },
          { name: '3_c.sql', sha256: C },
        ],
      ),
    ).toEqual([]);
  });

  it('ignores pending files, which have nothing recorded yet', () => {
    expect(verifyChecksums([], [{ name: '1_a.sql', sha256: A }])).toEqual([]);
  });

  it('names an applied file whose hash changed, with both hashes', () => {
    expect(
      verifyChecksums(
        [
          { name: '1_a.sql', sha256: A },
          { name: '2_b.sql', sha256: B },
        ],
        [
          { name: '1_a.sql', sha256: A },
          { name: '2_b.sql', sha256: C },
        ],
      ),
    ).toEqual([{ kind: 'changed', name: '2_b.sql', recorded: B, actual: C }]);
  });

  it('names an applied file that is gone from disk', () => {
    expect(verifyChecksums([{ name: '1_a.sql', sha256: A }], [])).toEqual([
      { kind: 'missing', name: '1_a.sql' },
    ]);
  });

  // A run recorded by the tool alone, without its hash, cannot be proved unchanged.
  it('names an applied file with no recorded hash', () => {
    expect(
      verifyChecksums([{ name: '1_a.sql', sha256: undefined }], [{ name: '1_a.sql', sha256: A }]),
    ).toEqual([{ kind: 'unrecorded', name: '1_a.sql' }]);
  });

  it('reports every problem in applied order, not just the first', () => {
    expect(
      verifyChecksums(
        [
          { name: '1_a.sql', sha256: A },
          { name: '2_b.sql', sha256: B },
          { name: '3_c.sql', sha256: C },
        ],
        [
          { name: '1_a.sql', sha256: B },
          { name: '3_c.sql', sha256: A },
        ],
      ).map((p) => `${p.kind}:${p.name}`),
    ).toEqual(['changed:1_a.sql', 'missing:2_b.sql', 'changed:3_c.sql']);
  });

  it('compares hashes exactly, not case insensitively', () => {
    expect(
      verifyChecksums(
        [{ name: '1_a.sql', sha256: A }],
        [{ name: '1_a.sql', sha256: A.toUpperCase() }],
      ),
    ).toHaveLength(1);
  });
});
