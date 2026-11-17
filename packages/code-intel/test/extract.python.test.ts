import { describe, expect, it } from 'vitest';
import { extractFile, loadGrammars } from '../src/index.ts';
import { expectFixture } from './helpers.ts';

describe('python extraction', () => {
  it('follows a literal __all__', async () => {
    const result = await expectFixture('python', 'python/client.py', 'acme/client.py');
    expect(result.routes).toEqual([]);
  });

  it('falls back to the underscore rule without __all__', async () => {
    await expectFixture('python', 'python/plain.py', 'acme/plain.py');
  });

  it.each([
    ['built from other names', '__all__ = ["a"] + other.__all__\ndef a(): pass\n'],
    ['extended later', '__all__ = ["a"]\n__all__ += ["b"]\ndef a(): pass\n'],
    ['made by a call', '__all__ = list(names)\n'],
  ])('marks a dynamic __all__ %s as partial', async (_case, source) => {
    const result = extractFile('python', source, await loadGrammars(), { path: 'm.py' });
    expect(result.partial).toBe(true);
  });
});
