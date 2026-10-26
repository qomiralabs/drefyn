import type { Rule } from 'eslint';

// Tailwind's reset removes the default scales, but brackets, variable shorthands, bare
// numbers (durations, delays, line widths, opacity, filters, stacking) and opacity modifiers
// still mint values that are not tokens. This rule closes those doors in any string, so a
// class list built in a variable is caught as well as one written in className.

// Arbitrary variants that select state are fine. The ones that invent a breakpoint, a
// container query or any other at rule are not, negated with not- or otherwise.
const VALUE_VARIANT = /^(not-)*(@?(min|max)-[[(]|@[[(]|\[@)/;
const ARBITRARY = /^[a-z][a-z0-9-]*-(\[[^\s]+\]|\([^\s]+\))(\/.+)?$/;
const ARBITRARY_MODIFIER = /^[a-z][a-z0-9-]*\/(\[[^\s]+\]|\([^\s]+\))$/;
const ARBITRARY_PROPERTY = /^\[[a-z-]+:[^\s]+\]$/;
// Every bare number pattern takes decimals too, because Tailwind compiles opacity-2.5.
const NUMBER = String.raw`(?<n>\d+(\.\d+)?)`;
const bare = (prefix: string) => new RegExp(`^(${prefix})-${NUMBER}$`);
// Zero is allowed for lengths and delays: it removes a line or a delay, it is not a size.
const BARE_DURATION = bare('duration');
const BARE_DELAY = bare('delay');
const BARE_STROKE = bare(
  'border(-([xytrblse]|bs|be))?|divide-[xy]|outline|ring|inset-ring|decoration|underline-offset|stroke',
);
const BARE_OFFSET = bare('outline-offset|ring-offset');
const BARE_OPACITY = bare('(backdrop-)?opacity');
// A colour with an opacity modifier: bg-ink/50. Fractions such as w-1/2 end in a digit.
const COLOR_OPACITY = new RegExp(`^[a-z]+(-[a-z]+)+\\/${NUMBER}$`);
// Filters that change colour. Each has one identity value that leaves the colour alone.
const FILTER = new RegExp(
  `^(backdrop-)?(?<name>brightness|contrast|saturate|grayscale|invert|sepia|hue-rotate)(-${NUMBER})?$`,
);
const FILTER_IDENTITY: Record<string, number> = {
  brightness: 100,
  contrast: 100,
  saturate: 100,
  grayscale: 0,
  invert: 0,
  sepia: 0,
  'hue-rotate': 0,
};
const BARE_LAYER = bare('z');
// A coloured drop shadow paints a colour nobody measured next to the text it sits under.
const DROP_SHADOW = /^drop-shadow-(?!none$)/;
// Blending makes the painted colour depend on whatever is underneath.
const BLEND = /^(mix|bg)-blend-(?!normal$)/;
// The theme narrows these three to fades under reduced motion, but a variant raises the
// specificity above motion-reduce:transition-none, so the author's opt out loses.
const MOVING_TRANSITION = /^transition(-all|-transform)?$/;

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

export type Problem =
  | 'arbitrary'
  | 'duration'
  | 'delay'
  | 'stroke'
  | 'offset'
  | 'opacity'
  | 'filter'
  | 'blend'
  | 'motion'
  | 'layer';

const value = (match: RegExpExecArray | null) =>
  match?.groups?.['n'] === undefined ? null : Number(match.groups['n']);

export function classify(token: string): Problem | null {
  const segments = parts(token);
  const utility = (segments.pop() ?? '').replace(/^!|!$/g, '').replace(/^-/, '');
  if (segments.some((v) => VALUE_VARIANT.test(v))) return 'arbitrary';
  if (ARBITRARY_PROPERTY.test(utility)) return 'arbitrary';
  if (ARBITRARY.test(utility) || ARBITRARY_MODIFIER.test(utility)) return 'arbitrary';
  const nonZero = (pattern: RegExp) => {
    const n = value(pattern.exec(utility));
    return n !== null && n !== 0;
  };
  if (nonZero(BARE_DURATION)) return 'duration';
  if (nonZero(BARE_DELAY)) return 'delay';
  if (nonZero(BARE_STROKE)) return 'stroke';
  if (nonZero(BARE_OFFSET)) return 'offset';
  // Full opacity and none are the measured colour or nothing; anything between is not measured.
  const opacity = value(BARE_OPACITY.exec(utility)) ?? value(COLOR_OPACITY.exec(utility));
  if (opacity !== null && opacity !== 0 && opacity !== 100) return 'opacity';
  const filter = FILTER.exec(utility);
  if (filter !== null) {
    const name = filter.groups?.['name'] ?? '';
    // A bare grayscale or invert is the full effect.
    const amount = value(filter) ?? 100;
    if (amount !== FILTER_IDENTITY[name]) return 'filter';
  }
  if (DROP_SHADOW.test(utility)) return 'filter';
  if (BLEND.test(utility)) return 'blend';
  if (MOVING_TRANSITION.test(utility) && segments.length > 0 && !segments.includes('motion-safe')) {
    return 'motion';
  }
  if (BARE_LAYER.test(utility)) return 'layer';
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
        "'{{token}}' is a raw line width. Use border or outline, which read the stroke tokens; icons draw with --dr-stroke-icon.",
      offset: "'{{token}}' is a raw focus offset. Use focus-ring, which reads the focus tokens.",
      opacity:
        "'{{token}}' makes a colour the contrast tests never measured. Use a colour role as it is. Disabled controls use the disabled colours.",
      filter:
        "'{{token}}' changes colours the contrast tests never measured. Use a colour role as it is.",
      blend:
        "'{{token}}' blends with whatever is underneath, so the colour shown is one the contrast tests never measured. Use a colour role as it is.",
      motion:
        "'{{token}}' transitions movement behind a variant. Put transition or transition-colors on the element itself and only the colour behind the variant (transition-colors hover:bg-hover). Use motion-safe: only for a transition that really is scoped, such as motion-safe:sm:transition.",
      layer: "'{{token}}' is a raw stacking order. Use z-base, z-raised, z-overlay or z-toast.",
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
