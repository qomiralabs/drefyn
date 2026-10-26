# @drefyn/ui

Design tokens for every Drefyn surface. Components arrive in a later change.

## Tokens

`src/tokens/tokens.ts` is the only place a design value is written. Everything else is generated
from it:

| File                          | For                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@drefyn/ui/tokens.css`       | Every surface. Plain custom properties (`--dr-{family}-{role}[-{variant}]`), light on `:root`, dark from the system or `data-theme="dark"`, reduced motion, self hosted fonts. Works with JS off. |
| `@drefyn/ui/tailwind.css`     | Apps that use Tailwind. Import it after `tailwindcss`; it resets every Tailwind default so only token utilities exist.                                                                            |
| `@drefyn/ui/tokens.dtcg.json` | Design tools, in the W3C design tokens format. One way only.                                                                                                                                      |
| `echartsThemes`               | Dashboard charts. Register `drefyn-light` and `drefyn-dark` with ECharts.                                                                                                                         |

After changing `tokens.ts`, run `pnpm --filter @drefyn/ui tokens` and commit the generated files.
The tests fail if they drift.

## Public API

- `tokens`: the typed source, for example `tokens.color.state.broken.text.light`.
- `requiredPairs`, `forbiddenPairs`, `ruledOutPairs`, `measure`, `colorOf`, `minimum`: which
  colours may sit on which, and the ratio each pair measures.
- `washBackdrops`: the selection wash over each surface, as `accent.wash@ground`, `@raised` and
  `@sunken`. The wash is translucent, so it is measured where it lands.
- `disabledPairs`, `disabledCeiling`: the band disabled controls are held to.
- `decorativeRoles`: colour roles with no contrast minimum, each with its reason.
- `contrast`, `luminance`, `composite`, `floor2`: WCAG 2.x contrast, floored so a failure never
  prints as a pass.
- `themeScript`, `themeStorageKey`: the inline head script that applies a stored light or dark
  choice before paint. Put it in a `<script>` in `<head>`; it is static, so one CSP hash covers it.
- `echartsThemes`, `chartMotion(reducedMotion)`, `cubicBezier`: chart themes, and the motion
  options to apply with `chart.setOption(chartMotion(reduced))`. Reduced motion turns chart
  animation off.
- `reducedFadeCapMs`.

## Using the tokens

- Type: `text-body-m` is the 16px reading step; `text-body` is the body text colour. Display
  steps are for wide screens: below `sm`, use `display-s` or `title` for page titles, because
  `display-xl` and `display-l` set one or two words per line at 390px.
- Reading width: `max-w-measure` (35em) sets about 70 characters of Inter at any body size, and
  fits the 640px docs reading column at `body-l`.
- Focus: `focus-visible:focus-ring` draws the 2px ring with its 2px offset from the tokens.
- Hover fills: there is no neutral hover fill yet (#60). Do not paint `bg-rule` as a fill; it is
  a hairline colour that no contrast test measures under text.
- Stacking: `z-base`, `z-raised`, `z-overlay` and `z-toast`. Bare `z-N` is rejected.
- Motion: under reduced motion, plain `transition`, `transition-all` and `transition-transform`
  fade colour and opacity only, so nothing travels. Use `duration-move-*` for movement. The
  override matches the plain class names only, so write `transition` without a variant, or put
  movement behind `motion-safe:`.
- Numbers: `time`, `data`, `output`, table cells and `[data-numeric]` get tabular figures from
  `tokens.css`.

## Rules the tests hold

- Text pairs reach 4.5:1 and marks and control edges reach 3:1, in both modes.
- Every colour role is measured in at least one pair, or listed in `decorativeRoles` with a
  reason (`border.rule` and `border.rule-strong` are hairlines).
- `text.subtle` sits on the ground only in light; amber and teal marks never stand alone.
- The selection wash is measured over every surface. Ink, body, secondary and accent ink text
  and the focus ring pass on it everywhere. Nothing coloured sits on it: a selected row shows
  state with its icon and ink text, never state coloured text or subtle text, and draws its
  edge from `border.rule`, not `border.control`. The pairs that fail are must fail pairs; the
  rest are in `ruledOutPairs`.
- Disabled controls paint with `disabled.fill`, `disabled.edge` and `disabled.text`, never with
  opacity. Each pair measures at or above its floor (2:1 for labels, 1.3:1 for edges) and below
  3:1 in both modes, so a disabled control is findable but never passes for a live one.
- The reading measure sets 68 to 72 characters per line on average, and no line over 78,
  measured with the shipped Inter.
- Under reduced motion nothing travels and no fade runs past 120 ms.
- `tokens.css` stays under 2.5 KB gzipped.
- Fonts are Latin subsets with their full OFL licences beside them in `src/fonts`. Each file has
  its source tarball, version and SHA-256 in `ASSETS.md`, and the tests check all three, plus
  the weight class against the file name.

`drefyn/no-arbitrary-values` from `scripts/lint-rules` rejects arbitrary Tailwind values
(`p-[13px]`) and at rule variants, bare durations, delays, line widths, offsets and stacking
orders, partial opacity, colour opacity modifiers and colour changing filters. Raw literals in
hand written CSS are not checked yet (#55).

## Preview

`pnpm --filter @drefyn/ui preview` writes `preview/dist/index.html`, a specimen of every token.
Serve `packages/ui` over HTTP and open `/preview/dist/index.html`. It is not shipped.

## Test

`pnpm --filter @drefyn/ui test`
