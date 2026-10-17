import type { Rule } from 'eslint';

// Tailwind's reset removes the default scales, but brackets, variable shorthands, bare
// numbers (durations, delays, line widths, opacity) and opacity modifiers still mint values
// that are not tokens. This rule closes
// those doors in any string, so a class list built in a variable is caught as well as one
// written in className.

// Arbitrary variants that select state are fine; the ones that invent a breakpoint are not.
const VALUE_VARIANT = /^@?(min|max)-[[(]/;
const ARBITRARY = /^[a-z][a-z0-9-]*-(\[[^\s]+\]|\([^\s]+\))(\/.+)?$/;
const ARBITRARY_MODIFIER = /^[a-z][a-z0-9-]*\/(\[[^\s]+\]|\([^\s]+\))$/;
const ARBITRARY_PROPERTY = /^\[[a-z-]+:[^\s]+\]$/;
// Bare numbers outside a scale. Zero is allowed: it removes a line or a delay, it is not a size.
const BARE_DURATION = /^duration-[1-9]\d*$/;
const BARE_DELAY = /^delay-[1-9]\d*$/;
const BARE_STROKE =
  /^(border(-[xytrblse])?|divide-[xy]|outline|outline-offset|ring|ring-offset|inset-ring)-[1-9]\d*$/;
// Full opacity and none are the measured colour or nothing; anything between is not measured.
const BARE_OPACITY = /^(backdrop-)?opacity-([1-9]\d?)$/;
// A colour with an opacity modifier: bg-ink/50. Fractions such as w-1/2 end in a digit.
const COLOR_OPACITY = /^[a-z]+(-[a-z]+)+\/\d+$/;

// Splits on ":" outside brackets and parentheses, so data-[state=open]:p-4 keeps its variant.
function parts(token: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of token) {
    if (char === '[' || char === '(') depth += 1;
    if (char === ']' || char === ')') depth -= 1;
    if (char === ':' && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  out.push(current);
  return out;
}

export type Problem = 'arbitrary' | 'duration' | 'delay' | 'stroke' | 'opacity';

export function classify(token: string): Problem | null {
  const segments = parts(token);
  const utility = (segments.pop() ?? '').replace(/^!|!$/g, '').replace(/^-/, '');
  if (segments.some((v) => VALUE_VARIANT.test(v))) return 'arbitrary';
  if (ARBITRARY_PROPERTY.test(utility)) return 'arbitrary';
  if (ARBITRARY.test(utility) || ARBITRARY_MODIFIER.test(utility)) return 'arbitrary';
  if (BARE_DURATION.test(utility)) return 'duration';
  if (BARE_DELAY.test(utility)) return 'delay';
  if (BARE_STROKE.test(utility)) return 'stroke';
  if (BARE_OPACITY.test(utility)) return 'opacity';
  if (COLOR_OPACITY.test(utility)) return 'opacity';
  return null;
}

export const noArbitraryValues: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Only token utilities: no arbitrary or off scale Tailwind values' },
    schema: [],
    messages: {
      arbitrary:
        "'{{token}}' is an arbitrary value. Use a utility from the token theme, or add a token.",
      duration:
        "'{{token}}' is a raw duration that ignores reduced motion. Use duration-fast, duration-base or duration-slow.",
      delay:
        "'{{token}}' is a raw delay outside the motion tokens. Sequence with duration tokens, or add a token.",
      stroke:
        "'{{token}}' is a raw line width. Use border or outline, which read the stroke tokens.",
      opacity:
        "'{{token}}' makes a colour the contrast tests never measured. Use a colour role as it is.",
    },
  },
  create(context) {
    const check = (node: Rule.Node, text: string) => {
      for (const token of text.split(/\s+/)) {
        if (token === '') continue;
        const problem = classify(token);
        if (problem !== null) context.report({ node, messageId: problem, data: { token } });
      }
    };
    return {
      Literal(node) {
        if (typeof node.value !== 'string') return;
        const parent = node.parent;
        // Module paths are not class lists: import x from './[slug].ts'.
        if (
          parent.type === 'ImportDeclaration' ||
          parent.type === 'ExportAllDeclaration' ||
          parent.type === 'ExportNamedDeclaration' ||
          parent.type === 'ImportExpression'
        ) {
          return;
        }
        check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
};
