// A reference and not an import, as the file holds only an ambient module, and it has to reach
// whichever package compiles this source.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./postcss-tokenize.d.ts" />
import postcss, { Input } from 'postcss';
import tokenizer from 'postcss/lib/tokenize';
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

function hasBareBreak(text: string): boolean {
  for (let at = 0; at < text.length; at += 1) {
    if (text.charAt(at) === '\\') at += 1;
    else if (LINE_BREAKS.has(text.charAt(at))) return true;
  }
  return false;
}

function endsInEscape(text: string): boolean {
  let at = text.length;
  while (at > 0 && text.charAt(at - 1) === '\\') at -= 1;
  return (text.length - at) % 2 === 1;
}

// Rejects the places where a browser and postcss split a sheet differently, since a rule that
// postcss takes for a string or a comment is live in the browser and no check below sees it:
// a browser ends a string at a bare line break, reads \/ as an escape where postcss opens a
// comment, and reads anything after url( but a string as one raw URL, quotes and comments
// included, while postcss only does so for the exact lowercase spelling. Honest sheets lose
// little: a comment inside brackets, or url( with a space and no quotes.
function splitsLikeNoBrowser(css: string): boolean {
  const tokens = tokenizer(new Input(css, { map: false }));
  let previous: readonly [string, string, ...number[]] | undefined;
  let depth = 0;
  let afterUrl = false;
  for (let token = tokens.nextToken(); token !== undefined; token = tokens.nextToken()) {
    const [type, text] = token;
    if (type === 'space') continue;
    if (afterUrl && type !== 'string') return true;
    afterUrl = false;
    if (type === 'string' && hasBareBreak(text)) return true;
    if (type === 'comment' && (depth > 0 || endsInEscape(previous?.[1] ?? ''))) return true;
    if (type === '(') {
      depth += 1;
      afterUrl = previous?.[0] === 'word' && nameOf(previous[1]) === 'url';
    }
    if (type === ')') depth = Math.max(0, depth - 1);
    previous = token;
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
  const problems: CssProblem[] = [];
  try {
    if (splitsLikeNoBrowser(css)) return refuse('css.parse_failed');
    // Without map: false postcss reads whatever file a source map comment names.
    walk(postcss.parse(css, { map: false }), problems);
  } catch {
    return refuse('css.parse_failed');
  }
  return problems.length === 0 ? { ok: true, value: css } : { ok: false, error: problems };
}
