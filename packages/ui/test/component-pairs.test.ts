import { describe, expect, it } from 'vitest';
import {
  disabledPairs,
  expandPairs,
  forbiddenPairs,
  measure,
  minimum,
  requiredPairs,
  ruledOutPairs,
  supplementaryMarks,
  type ColorRole,
  type Pair,
  type PairKind,
} from '../src/tokens/pairs.ts';
import type { Mode } from '../src/tokens/tokens.ts';

interface Use {
  component: string;
  fg: ColorRole;
  bg: ColorRole;
  kind: PairKind;
  // A mark beside its word carries no minimum; a disabled pair is held to its band instead.
  role?: 'supplementary' | 'disabled';
}

const MODES: readonly Mode[] = ['light', 'dark'];
const ON = ['surface.ground', 'surface.raised'] as const;
const FILLS = ['surface.hover', 'surface.pressed'] as const;

const each = (
  component: string,
  fgs: readonly ColorRole[],
  bgs: readonly ColorRole[],
  kind: PairKind,
  role?: Use['role'],
): Use[] =>
  fgs.flatMap((fg) =>
    bgs.map((bg) => ({ component, fg, bg, kind, ...(role === undefined ? {} : { role }) })),
  );

// Every colour combination the first batch of components paints, by component. A new
// combination is added here with the component, and must be a measured pair before it ships.
const USES: Use[] = [
  ...each('Button primary', ['accent.on'], ['accent.ink', 'accent.press'], 'text'),
  ...each('Button secondary', ['text.body'], [...ON, 'surface.hover', 'surface.pressed'], 'text'),
  ...each('Button quiet', ['text.secondary'], [...ON, ...FILLS], 'text'),
  ...each('Button focus', ['focus.ring'], ON, 'non-text'),
  ...each('Button disabled', ['disabled.text'], ['disabled.fill', ...ON], 'text', 'disabled'),
  ...each('Button disabled', ['disabled.edge'], ['disabled.fill', ...ON], 'non-text', 'disabled'),
  ...each(
    'Badge word',
    ['state.fresh.text', 'state.stale.text', 'state.broken.text', 'state.neutral.text'],
    ON,
    'text',
  ),
  ...each('Badge word on a fill', ['text.body'], FILLS, 'text'),
  ...each('Badge and pip icon', ['state.fresh.mark', 'state.broken.mark'], ON, 'non-text'),
  // Amber and the neutral hatch draw in their text colour, which clears 3:1 as a mark.
  ...each('Badge and pip icon', ['state.stale.text', 'state.neutral.text'], ON, 'text'),
  ...each(
    'Badge icon on a fill',
    ['state.fresh.mark', 'state.stale.mark', 'state.broken.mark', 'state.neutral.mark'],
    FILLS,
    'non-text',
    'supplementary',
  ),
  ...each('StatusDot word', ['text.body'], ON, 'text'),
  ...each('EmptyState', ['text.ink', 'text.body', 'text.secondary'], ON, 'text'),
  ...each('EmptyState error icon', ['state.broken.mark'], ON, 'non-text'),
  // The thumb is paper on the track, so the track against paper is the same ratio.
  ...each('Switch track off', ['border.control'], ON, 'non-text'),
  ...each('Switch track on', ['accent.ink'], ON, 'non-text'),
  ...each('Switch label', ['text.body'], ON, 'text'),
  // The description carries a disabled switch's reason, so it stays secondary, not disabled.
  ...each('Switch description', ['text.secondary'], ON, 'text'),
  ...each('Switch disabled', ['disabled.edge'], ['disabled.fill', ...ON], 'non-text', 'disabled'),
  ...each('Switch disabled', ['disabled.text'], ON, 'text', 'disabled'),
  // Menus float on the overlay surface, an alias of ground in light and raised in dark.
  ...each('Menu item', ['text.body', 'text.secondary'], [...ON, ...FILLS], 'text'),
  ...each('Menu item focus', ['focus.ring'], FILLS, 'non-text'),
  ...each('Menu disabled item', ['disabled.text'], ON, 'text', 'disabled'),
];

const key = (p: { mode: Mode; fg: string; bg: string; kind: PairKind }) =>
  `${p.mode} ${p.fg} on ${p.bg} (${p.kind})`;
const keys = (pairs: Pair[]) => new Set(pairs.map(key));

const required = keys(expandPairs(requiredPairs));
const supplementary = keys(expandPairs(supplementaryMarks));
const disabled = keys(expandPairs(disabledPairs));
const never = keys([...expandPairs(forbiddenPairs), ...expandPairs(ruledOutPairs)]);

describe('colour combinations the components paint', () => {
  it('lists every component in the batch', () => {
    const named = new Set(USES.map((u) => u.component.split(' ')[0]));
    expect([...named].sort()).toEqual(
      ['Badge', 'Button', 'EmptyState', 'Menu', 'StatusDot', 'Switch'].sort(),
    );
  });

  for (const use of USES) {
    for (const mode of MODES) {
      const pair = { mode, fg: use.fg, bg: use.bg, kind: use.kind };
      it(`${use.component}: ${key(pair)} is a measured pair`, () => {
        expect(never.has(key(pair)), 'forbidden or ruled out').toBe(false);
        // Contrast is symmetric, so a mark on a surface also covers the surface on the mark.
        const reverse = key({ ...pair, fg: use.bg, bg: use.fg });
        const table =
          use.role === 'supplementary'
            ? supplementary
            : use.role === 'disabled'
              ? disabled
              : required;
        expect(table.has(key(pair)) || table.has(reverse), 'listed').toBe(true);
        if (use.role === undefined) {
          expect(measure(pair, mode)).toBeGreaterThanOrEqual(minimum[use.kind]);
        }
      });
    }
  }
});
