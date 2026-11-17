import { beforeAll, describe, expect, it } from 'vitest';
import { extractFile, loadGrammars } from '../src/index.ts';
import type { LoadedGrammars } from '../src/index.ts';

// Paths and sources come from customer repositories, so a crafted one must not buy quadratic
// time in the code that reads conventions out of them.
let grammars: LoadedGrammars;
beforeAll(async () => {
  grammars = await loadGrammars();
});

const elapsed = (run: () => void): number => {
  const start = performance.now();
  run();
  return performance.now() - start;
};

describe('linear time on crafted input', () => {
  it('reads a Next route convention from a 50k character path in time', () => {
    const source = 'export function GET() { return new Response(); }\n';
    const path = `app/${'./app/'.repeat(8_400)}`;
    expect(path.length).toBeGreaterThan(50_000);
    // Parser setup and the parse dominate on a busy runner, so a plain path of the same length
    // is the baseline, timed after a first call has warmed the grammar.
    const plain = 'a/'.repeat(path.length / 2);
    extractFile('typescript', source, grammars, { path: plain });
    const baseline = elapsed(() => extractFile('typescript', source, grammars, { path: plain }));
    const time = elapsed(() => extractFile('typescript', source, grammars, { path }));
    expect(time).toBeLessThan(baseline * 2 + 50);
  });

  it('still finds the route when the path repeats app/ many times', () => {
    const source = 'export function GET() { return new Response(); }\n';
    const path = `app/${'x/app/'.repeat(8_400)}users/route.ts`;
    const result = extractFile('typescript', source, grammars, { path });
    expect(result.routes.map((route) => route.route)).toEqual([`/${'x/app/'.repeat(8_400)}users`]);
  });

  it('takes the first app folder whose remaining folders are all named', () => {
    const source = 'export function GET() { return new Response(); }\n';
    const routes = (path: string): string[] =>
      extractFile('typescript', source, grammars, { path }).routes.map((route) => route.route);
    expect(routes('app//app/users/route.ts')).toEqual(['/users']);
    expect(routes('lib/app/a/app/b/route.tsx')).toEqual(['/a/app/b']);
    expect(routes('myapp/users/route.ts')).toEqual([]);
    expect(routes('app/users/route.tsx.bak')).toEqual([]);
    expect(routes('app/route.mjs')).toEqual(['/']);
  });

  it('reads the crate of a deeply nested use list in time', () => {
    // A line break inside the braces is what made the old pattern retry from every brace, so
    // the same nesting without one is the baseline for parse time on this machine.
    const depth = 25_000;
    const slow = `use ${'{'.repeat(depth)}x\n${'}'.repeat(depth)};\n`;
    const fast = `use ${'{'.repeat(depth)}x ${'}'.repeat(depth)};\n`;
    const baseline = elapsed(() => extractFile('rust', fast, grammars, { path: 'a.rs' }));
    const time = elapsed(() => extractFile('rust', slow, grammars, { path: 'a.rs' }));
    expect(time).toBeLessThan(baseline * 2 + 50);
  });
});
