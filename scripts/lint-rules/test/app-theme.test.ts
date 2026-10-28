import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkAppTheme } from '../src/app-theme.ts';
import { main } from '../src/check-packages.ts';
import { goodPackage, tempWorkspace, type TempWorkspace } from './helpers.ts';

// Apps may only compose tokens: an @theme inline entry built from --dr-* variables and CSS
// functions. Every raw design value lives in packages/ui.
const COMPOSED = `@import 'tailwindcss';
@theme inline {
  --spacing-shell-bar: var(--dr-shell-bar);
  --height-shell-view: calc(100dvh - var(--dr-shell-bar));
}
`;

describe('checkAppTheme', () => {
  it('accepts entries composed from --dr-* variables and CSS functions', () => {
    expect(checkAppTheme(COMPOSED)).toEqual([]);
  });

  it('ignores CSS outside @theme', () => {
    expect(
      checkAppTheme('.a { width: 64rem; color: #fff; }\n@media (width >= 64rem) {}\n'),
    ).toEqual([]);
  });

  it.each([
    ['a raw breakpoint', '@theme inline {\n  --breakpoint-md: 64rem;\n}\n', '--breakpoint-md'],
    ['a raw length', '@theme inline {\n  --container-landing: 45rem;\n}\n', '--container-landing'],
    ['a colour', '@theme inline {\n  --color-brand: #4f46e5;\n}\n', '--color-brand'],
    [
      'a variable that is not a token',
      '@theme inline {\n  --spacing-x: var(--tw-gap);\n}\n',
      '--spacing-x',
    ],
    [
      'a function with no token in it',
      '@theme inline {\n  --height-x: calc(100dvh - 3rem);\n}\n',
      '--height-x',
    ],
    ['a reset', '@theme inline {\n  --*: initial;\n}\n', '--*'],
  ])('refuses %s', (_label, css, name) => {
    const findings = checkAppTheme(css);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toContain(name);
  });

  it('refuses a plain @theme block, which is where raw values go', () => {
    const findings = checkAppTheme('@theme {\n  --spacing-x: var(--dr-space-8);\n}\n');
    expect(findings.map((f) => f.detail)).toEqual([
      'line 1: apps add @theme inline entries only; values go in packages/ui tokens',
    ]);
  });

  it('gives the line of each refused entry', () => {
    expect(checkAppTheme(`${COMPOSED}@theme inline {\n  --breakpoint-md: 64rem;\n}\n`)).toEqual([
      {
        line: 7,
        detail:
          'line 7: --breakpoint-md: 64rem is not composed from --dr-* tokens; add the value to packages/ui tokens',
      },
    ]);
  });
});

describe('check-packages on app stylesheets', () => {
  let ws: TempWorkspace;
  let out = '';
  let err = '';
  const io = {
    out: (text: string) => {
      out += text;
    },
    err: (text: string) => {
      err += text;
    },
  };
  beforeEach(() => {
    ws = tempWorkspace();
    out = '';
    err = '';
    ws.manifest('apps/web', goodPackage('web'));
    ws.write('apps/web/src/index.ts', 'export const a = 1;\n');
  });
  afterEach(() => {
    ws.cleanup();
  });

  it('passes an app that only composes tokens', () => {
    ws.write('apps/web/src/app/globals.css', COMPOSED);
    expect(main(['--root', ws.root], io)).toBe(0);
    expect(err).toBe('');
  });

  it('fails an app that adds a raw value', () => {
    ws.write('apps/web/src/app/globals.css', '@theme inline {\n  --breakpoint-md: 64rem;\n}\n');
    expect(main(['--root', ws.root], io)).toBe(1);
    expect(err).toBe(
      'apps/web (@drefyn/web): src/app/globals.css: line 2: --breakpoint-md: 64rem is not composed from --dr-* tokens; add the value to packages/ui tokens\n' +
        'check:packages: 1 problem\n',
    );
    expect(out).toBe('');
  });

  it('leaves stylesheets in packages alone', () => {
    ws.manifest('packages/ui', goodPackage('ui'));
    ws.write('packages/ui/src/index.ts', 'export const a = 1;\n');
    ws.write('packages/ui/src/theme.css', '@theme {\n  --breakpoint-md: 64rem;\n}\n');
    expect(main(['--root', ws.root], io)).toBe(0);
  });
});
