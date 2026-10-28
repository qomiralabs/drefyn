// Apps may extend the Tailwind theme only by composing tokens: `@theme inline` entries whose
// values are built from --dr-* variables and CSS functions. Every raw design value lives in
// packages/ui, where the token tests measure it.

export interface ThemeFinding {
  line: number;
  detail: string;
}

const FUNCTIONS = new Set(['var', 'calc', 'min', 'max', 'clamp']);

// One value is composed when it is a CSS function, every variable in it is a token, at least
// one token is used, and no colour or other function hides inside.
function composed(value: string): boolean {
  const head = /^([a-z-]+)\(/.exec(value);
  if (head === null || !FUNCTIONS.has(head[1] ?? '')) return false;
  const functions = [...value.matchAll(/([a-z-]+)\(/g)].map((m) => m[1] ?? '');
  if (!functions.every((f) => FUNCTIONS.has(f))) return false;
  if (/#[0-9a-f]{3,8}\b/i.test(value)) return false;
  const variables = [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1] ?? '');
  return variables.length > 0 && variables.every((v) => v.startsWith('--dr-'));
}

const lineAt = (source: string, index: number) => source.slice(0, index).split('\n').length;

// Comments are blanked to spaces, so positions and line numbers stay where they were.
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));

export function checkAppTheme(source: string): ThemeFinding[] {
  const css = withoutComments(source);
  const findings: ThemeFinding[] = [];
  for (const block of css.matchAll(/@theme\b([^{]*)\{([^}]*)\}/g)) {
    const start = block.index;
    const options = (block[1] ?? '').trim().split(/\s+/);
    if (!options.includes('inline')) {
      const line = lineAt(css, start);
      findings.push({
        line,
        detail: `line ${line}: apps add @theme inline entries only; values go in packages/ui tokens`,
      });
      continue;
    }
    const body = block[2] ?? '';
    const bodyStart = start + block[0].indexOf('{') + 1;
    for (const entry of body.matchAll(/(--[\w*-]+)\s*:\s*([^;]+);/g)) {
      const name = entry[1] ?? '';
      const value = (entry[2] ?? '').trim();
      if (!name.includes('*') && composed(value)) continue;
      const line = lineAt(css, bodyStart + entry.index);
      findings.push({
        line,
        detail: `line ${line}: ${name}: ${value} is not composed from --dr-* tokens; add the value to packages/ui tokens`,
      });
    }
  }
  return findings;
}
