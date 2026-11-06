import postcss from 'postcss';
import type { AtRule, ChildNode, Container, Declaration, Rule } from 'postcss';
import type { Result } from './types.ts';

export type CssProblemCode =
  | 'css.too_large'
  | 'css.parse_failed'
  | 'css.markup'
  | 'css.import'
  | 'css.foreign_url'
  | 'css.expression'
  | 'css.forbidden_at_rule'
  | 'css.forbidden_function'
  | 'css.forbidden_property';

// Codes and places only: a problem can reach a log, and customer text must not.
export interface CssProblem {
  readonly code: CssProblemCode;
  readonly line: number;
  readonly column: number;
}

const MAX_BYTES = 131_072;
const MAX_PROBLEMS = 20;

const AT_RULES = new Set([
  'container',
  'font-face',
  'keyframes',
  'layer',
  'media',
  'supports',
  '-webkit-keyframes',
]);

// Names, not patterns: a browser adds a function that reads a URL now and then (image-set did),
// and that has to fail here until someone looks at it.
const FUNCTIONS = new Set(
  (
    'abs acos asin atan atan2 attr blur brightness calc circle clamp color color-mix conic-gradient ' +
    'contrast cos counter counters cubic-bezier drop-shadow ellipse exp fit-content format ' +
    'grayscale hsl hsla hue-rotate hwb hypot inset invert lab lch light-dark linear-gradient local ' +
    'log matrix matrix3d max min minmax mod oklab oklch opacity perspective polygon pow ' +
    'radial-gradient rem repeat repeating-conic-gradient repeating-linear-gradient ' +
    'repeating-radial-gradient rgb rgba rotate rotate3d rotatex rotatey rotatez round saturate ' +
    'scale scale3d scalex scaley scalez sepia sign sin skew skewx skewy sqrt steps tan translate ' +
    'translate3d translatex translatey translatez var'
  ).split(' '),
);

const PROPERTIES = new Set(['behavior', '-moz-binding']);

// In a style element these end it, whatever CSS thinks they are.
const MARKUP = /<[/!]/;

const COMMENT = /\/\*[^]*?(?:\*\/|$)/g;
const ESCAPE = /\\(?:([0-9a-f]{1,6})[ \t\n\r\f]?|\r\n|([^]))/gi;
// A string, or a name with its bracket if it has one. Every path consumes what it matches, a
// name with no bracket included, so a long sheet is read once and not rescanned from each byte.
const TOKEN =
  /"(?:[^"\\]|\\[^])*"?|'(?:[^'\\]|\\[^])*'?|((?:[-\w]|[^\0-\x7f]|\\[0-9a-f]{1,6}[ \t\n\r\f]?|\\[^])+)(\(\s*(?:"((?:[^"\\]|\\[^])*)"?|'((?:[^'\\]|\\[^])*)'?|((?:[^)\\]|\\[^])*))?)?/gi;

// http, so a URL that takes its scheme from here cannot pass as https.
const SITE_BASE = 'http://page.invalid/';
const SITE_ORIGIN = 'http://page.invalid';

// Turns a CSS escape into its character, which is how a filter gets walked around: a browser
// reads ur\6c( as url(.
function unescape(text: string): string {
  return text.replace(ESCAPE, (_match, hex: string | undefined, other: string | undefined) => {
    if (hex !== undefined) {
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '�';
    }
    return other ?? '';
  });
}

const nameOf = (text: string) => unescape(text).toLowerCase();

function isOwnOrHttps(target: string): boolean {
  try {
    const url = new URL(target.trim(), SITE_BASE);
    return url.origin === SITE_ORIGIN || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function functionProblem(name: string, argument: string): CssProblemCode | undefined {
  if (name === 'expression') return 'css.expression';
  if (name === 'url') return isOwnOrHttps(unescape(argument)) ? undefined : 'css.foreign_url';
  return FUNCTIONS.has(name) ? undefined : 'css.forbidden_function';
}

function valueProblems(raw: string): CssProblemCode[] {
  const problems: CssProblemCode[] = [];
  for (const match of raw.replace(COMMENT, '').matchAll(TOKEN)) {
    const [, fn, bracket, double, single, bare] = match;
    if (fn === undefined || bracket === undefined) continue;
    const problem = functionProblem(nameOf(fn), double ?? single ?? bare ?? '');
    if (problem !== undefined) problems.push(problem);
  }
  return problems;
}

function atRuleProblems(node: AtRule): CssProblemCode[] {
  const name = nameOf(node.name);
  if (name === 'import') return ['css.import'];
  if (!AT_RULES.has(name)) return ['css.forbidden_at_rule'];
  return valueProblems(node.raws.params?.raw ?? node.params);
}

function declarationProblems(node: Declaration): CssProblemCode[] {
  if (PROPERTIES.has(nameOf(node.prop))) return ['css.forbidden_property'];
  return valueProblems(node.raws.value?.raw ?? node.value);
}

function problemsOf(node: ChildNode): CssProblemCode[] {
  if (node.type === 'atrule') return atRuleProblems(node);
  if (node.type === 'decl') return declarationProblems(node);
  return [];
}

const LINE_BREAKS = new Set(['\n', '\r', '\f']);

// Where the string opening here ends, or -1 if it never closes on its own line.
function endOfString(css: string, open: number): number {
  for (let at = open + 1; at < css.length; at += 1) {
    const char = css.charAt(at);
    if (char === css.charAt(open)) return at + 1;
    if (LINE_BREAKS.has(char)) return -1;
    if (char === '\\') at += 1;
  }
  return -1;
}

// A browser ends a string at a bare line break and keeps reading rules. postcss reads on to the
// closing quote, so what looks like one string here can hold a live rule there. A plain scan
// and not a pattern, so a sheet of quotes and backslashes costs one pass.
function hasBrokenString(css: string): boolean {
  let at = 0;
  while (at !== -1 && at < css.length) {
    const char = css.charAt(at);
    if (char === '"' || char === "'") {
      at = endOfString(css, at);
      if (at === -1) return true;
    } else if (css.startsWith('/*', at)) {
      at = css.indexOf('*/', at + 2);
      if (at !== -1) at += 2;
    } else {
      at += 1;
    }
  }
  return false;
}

const refuse = (
  code: CssProblemCode,
  line = 1,
  column = 1,
): Result<string, readonly CssProblem[]> => ({
  ok: false,
  error: [{ code, line, column }],
});

// Its own stack, since a sheet can nest as deep as its size allows.
function walk(root: Container, problems: CssProblem[]): void {
  const pending: (Container | Rule | AtRule)[] = [root];
  for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
    for (const node of parent.nodes ?? []) {
      const { line = 1, column = 1 } = node.source?.start ?? {};
      for (const code of problemsOf(node)) {
        if (problems.length < MAX_PROBLEMS) problems.push({ code, line, column });
      }
      if (node.type === 'rule' || node.type === 'atrule') pending.push(node);
    }
  }
}

// Rejects, and never rewrites: a sheet that is cleaned behind its author's back fails in ways
// nobody can see. Names and values are read from the parsed sheet one at a time, and not by
// decoding the whole text first, since decoding can open a string that hides the next rule.
export function checkCustomCss(css: string): Result<string, readonly CssProblem[]> {
  if (typeof css !== 'string') return refuse('css.parse_failed');
  if (Buffer.byteLength(css, 'utf8') > MAX_BYTES) return refuse('css.too_large');
  if (MARKUP.test(css)) return refuse('css.markup');
  if (hasBrokenString(css)) return refuse('css.parse_failed');
  const problems: CssProblem[] = [];
  try {
    // Without map: false postcss reads whatever file a source map comment names.
    walk(postcss.parse(css, { map: false }), problems);
  } catch {
    return refuse('css.parse_failed');
  }
  return problems.length === 0 ? { ok: true, value: css } : { ok: false, error: problems };
}
