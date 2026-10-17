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
- `requiredPairs`, `forbiddenPairs`, `measure`, `colorOf`, `minimum`: which colours may sit on
  which, and the ratio each pair measures.
- `contrast`, `luminance`, `composite`, `floor2`: WCAG 2.x contrast, floored so a failure never
  prints as a pass.
- `themeScript`, `themeStorageKey`: the inline head script that applies a stored light or dark
  choice before paint. Put it in a `<script>` in `<head>`; it is static, so one CSP hash covers it.
- `echartsThemes`, `reducedFadeCapMs`.

## Rules the tests hold

- Text pairs reach 4.5:1 and marks and control edges reach 3:1, in both modes.
- `text.subtle` sits on the ground only in light; amber and teal marks never stand alone.
- Under reduced motion nothing travels and no fade runs past 120 ms.
- `tokens.css` stays under 2.5 KB gzipped.
- Fonts are Latin subsets with their OFL licences beside them in `src/fonts`.

Arbitrary Tailwind values (`p-[13px]`), bare durations, delays, line widths and opacity, and colour
opacity modifiers are rejected by `drefyn/no-arbitrary-values` from `scripts/lint-rules`.

## Preview

`pnpm --filter @drefyn/ui preview` writes `preview/dist/index.html`, a specimen of every token.
Serve `packages/ui` over HTTP and open `/preview/dist/index.html`. It is not shipped.

## Test

`pnpm --filter @drefyn/ui test`
