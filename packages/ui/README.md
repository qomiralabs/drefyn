# @drefyn/ui

Design tokens and React components for every Drefyn surface.

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
- `supplementaryMarks`: state icons on the hover and pressed fills, which sit beside their word
  and so carry no 3:1 minimum.
- `fillBackdrops`, `fillFloor`: the surfaces the hover and pressed fills may sit on, and how far
  off them they must be.
- `aliasRoles`: colour roles that resolve to another role per mode (`surface.overlay`), so the
  pairs on that role cover them.
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
  Items flush inside a container (menu items, options, rows, cells) use
  `focus-visible:focus-ring-inset`, which draws the ring 2px inside their edge.
- Hover and pressed: `bg-hover` and `bg-pressed`, on items that sit on ground, raised or the
  overlay. Interactive items never sit on sunken: in dark the hover fill is only 1.02 off it.
  State words on anything that can be hovered, pressed or selected are `text-body` beside the
  state icon, which keeps its mark colour; state text colours are for sentences on ground and
  raised. A state mark with no word beside it never takes either fill. Disabled items take
  neither fill. Do not paint `bg-rule` as a
  fill; it is a hairline colour that no contrast test measures under text.
- Floating things: menus, popovers, tooltips, dialogs, the command bar and toasts sit on
  `bg-overlay` with `border-rule-strong` and `shadow-1` (`shadow-2` for the command bar and
  dialogs). It is paper in light and raised in dark, where shadows do not show.
- Scrim: `bg-overlay-scrim` behind dialogs and the command bar only, faded with `duration-base`.
  No blur.
- Sizes: `h-control-sm`, `h-control-md` and `h-control-lg` (24, 32 and 40px), `size-icon-sm`,
  `-md` and `-lg` (16, 20 and 24px). Rows use `min-h-row-compact` and `min-h-row-comfortable`
  (32 and 40px), so a row that wraps grows instead of clipping. The space scale has no 40; it
  exists only as a size, and sizes never become padding, gaps or widths.
- Selection: `border-l-indicator` or `border-b-indicator` marks the selected row, the current
  nav item and the selected tab. Put the stroke on every item, `border-transparent` at rest and
  `border-accent-ink` when selected, so labels do not jump when the selection moves.
- Shell: `h-shell-bar`, `w-shell-nav`, `w-shell-nav-collapsed`, `w-shell-drawer` (the phone
  drawer) and `w-shell-inspector` (incident mode's side column). Calm landings use
  `max-w-landing` (45rem).
- Breakpoints: `sm` 40rem, `md` 64rem and `lg` 80rem, literal in `tailwind.css` because a
  media query cannot read a custom property. Tailwind's own `xl` and `2xl` do not exist.
- Meters: `bg-meter-track` and `bg-meter-fill`, aliases of the rule and secondary ink. A plan
  limit never takes a state colour.
- Skeletons: `bg-skeleton-fill`, never under text, with no shimmer or pulse.
- Timers: `tokens.timer` and `--dr-timer-*` hold the waits (tooltip 500 ms, skeleton reveal
  200 ms, toast 6 s, toast with Undo 10 s). They are not Tailwind utilities and reduced motion
  never shortens them.
- Stacking: `z-base`, `z-raised`, `z-overlay` and `z-toast`. Bare `z-N` is rejected.
- Motion: under reduced motion, `transition`, `transition-all` and `transition-transform` fade
  colour and opacity only, so nothing travels. Use `duration-move-*` for movement. The narrowing
  sits in the utilities layer, so `motion-reduce:transition-none` still turns a transition off.
  Put the transition on the element itself and only the colour behind the variant:
  `transition-colors hover:bg-hover`, or a bare `transition` with `hover:text-ink`. A
  transition behind `hover:` fades in and snaps back out, and under reduced motion it loses the
  colour fade too. Keep `motion-safe:` for transitions that really are scoped, such as
  `motion-safe:sm:transition`. The lint rule rejects
  `hover:transition` because the variant would outrank `motion-reduce:transition-none`.
- Numbers: `time`, `data`, `output`, table cells and `[data-numeric]` get tabular figures from
  `tokens.css`.

## Rules the tests hold

- Text pairs reach 4.5:1 and marks and control edges reach 3:1, in both modes.
- Every colour role is measured in at least one pair, listed in `decorativeRoles` with a
  reason (`border.rule` and `border.rule-strong` are hairlines, `skeleton.fill` carries no
  text), or listed in `aliasRoles` with the hex of the role it resolves to.
- The hover and pressed fills carry ink, body, secondary and accent ink text, the focus ring
  and, on hover, the control edge in both modes. Green and amber state text and subtle text fail
  on them in light, and a pressed fill never draws a control edge. Both fills sit at least 1.04
  off ground, raised and the overlay, and the pressed fill a step past the hover fill. Hover on
  sunken is 1.02 in dark, so interactive items never sit on sunken. State marks on the fills
  are pinned but carry no minimum, because the word beside them carries the meaning.
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
- Under reduced motion nothing travels and no fade runs past 120 ms. Timers are untouched.
- `tokens.css` stays under 2.5 KB gzipped.
- Fonts are Latin subsets with their full OFL licences beside them in `src/fonts`. Each file has
  its source tarball, version and SHA-256 in `ASSETS.md`, and the tests check all three, plus
  the weight class against the file name.

`drefyn/no-arbitrary-values` from `scripts/lint-rules` rejects arbitrary Tailwind values
(`p-[13px]`) and at rule variants (negated ones too), bare durations, delays, line widths,
offsets and stacking orders, partial opacity, colour opacity modifiers, colour changing filters
and drop shadows, blend modes, and transitions that move behind a variant without
`motion-safe:`. Raw literals in
hand written CSS are not checked yet (#55).

## Two entries

| Import                 | Holds                                                    | Runs in                                        |
| ---------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| `@drefyn/ui`           | Tokens, contrast helpers, the head script, chart motion. | Anywhere, including plain Node. No React.      |
| `@drefyn/ui/react`     | Components.                                              | React 19 apps. React is a peer dependency.     |
| `@drefyn/ui/react.css` | `@source "./"` for the component files.                  | An app's Tailwind entry, after `tailwind.css`. |

The token entry never imports React or a `.tsx` file, because Node refuses `.tsx` under type
stripping and token only consumers should not install React. A test walks its import graph.

In an app that uses Tailwind:

```css
@import 'tailwindcss';
@import '@drefyn/ui/tailwind.css';
@import '@drefyn/ui/react.css';
```

### Writing a component

- One component per file in `src/react/`, exported from `src/react/index.ts` by name. Never
  `export *`: the split test reads the barrel to know which file each export comes from.
- Components are server components by default and ship no JS. A file that calls a hook or
  imports `react-aria-components` starts with `'use client'` as its first statement. The
  barrel never does. Badges, status marks, skeletons, empty states, buttons and icons must stay
  server safe; the split test renders each one with `renderToStaticMarkup`.
- Style only with token utilities. `style` and `dangerouslySetInnerHTML` are lint errors in
  `src/react/`, and Motion is a lint error everywhere except the dashboard and website apps.
  Animate with CSS transitions on the duration and ease tokens.
- Stories live in `stories/` and import only `../src/react/index.ts` (and `../src/index.ts` for
  token values), so they show what a consumer can import.

## Storybook and browser tests

- `pnpm --filter @drefyn/ui storybook` runs Storybook locally; `storybook:build` writes the
  static build to `storybook-static/`. Telemetry is off. The Theme toolbar sets `data-theme` on
  `<html>`, as an app does.
- `pnpm --filter @drefyn/ui test:e2e` runs Playwright over the static build: keyboard specs in
  Chromium, Firefox and WebKit, axe on every story in light, dark and 390 px, and the reduced
  motion check. Build first. The tests serve the build from disk and fail on any request to
  another host.
- `pnpm --filter @drefyn/ui test:visual` compares screenshots, but only inside the pinned
  Playwright Linux image, which it starts through Docker. It refuses to compare on a host,
  because fonts render differently there. `test:visual:update` writes the baselines, also in
  the image. The image always runs as linux/amd64, the build CI uses; on Apple Silicon Docker
  emulates it.
- CI (`.github/workflows/ui.yml`) builds Storybook once and runs every Playwright project in the
  same image with no network, three visual runs among them. A missing baseline fails.

### Updating screenshot baselines

1. Make the change and run `pnpm --filter @drefyn/ui storybook:build`.
2. Run `pnpm --filter @drefyn/ui test:visual`. A failure writes the expected, actual and diff
   images to `test-results/`; look at each one.
3. If every difference is intended, run `pnpm --filter @drefyn/ui test:visual:update`. Its
   output shows paths under `/work`, which is the image, not your machine.
4. Commit the changed PNGs under `e2e/__screenshots__/` with the change and say in the PR why
   each one moved. A new story adds three baselines: light, dark and light at 390 px.

Docker must be running. Never copy a screenshot taken on a host into `e2e/__screenshots__/`.

## Preview

`pnpm --filter @drefyn/ui preview` writes `preview/dist/index.html`, a specimen of every token.
Serve `packages/ui` over HTTP and open `/preview/dist/index.html`. It is not shipped.

## Test

`pnpm --filter @drefyn/ui test` runs the unit tests: node for tokens and checks, happy-dom for `test/react/`.
