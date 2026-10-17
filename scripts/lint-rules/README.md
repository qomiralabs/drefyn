# @drefyn/lint-rules

In repo ESLint rules, registered in the root `eslint.config.js` as the `drefyn` plugin.

## drefyn/no-arbitrary-values

On for `packages/ui` and `apps/*`. Reports any string that holds a Tailwind class which mints a
value outside the tokens:

- arbitrary values and properties: `p-[13px]`, `text-[#ff0000]`, `p-(--x)`, `[mask-type:alpha]`
- arbitrary breakpoints: `min-[700px]:p-16`
- raw durations and delays, which skip reduced motion and the motion tokens: `duration-200`,
  `delay-150`
- raw line widths, which skip the stroke tokens: `border-2`, `outline-2`, `ring-1`,
  `outline-offset-4` (plain `border` and `outline` read the stroke tokens)
- partial opacity, which makes colours nobody measured: `opacity-50`
- zero is allowed (`border-0`, `delay-0`), and so are `opacity-0` and `opacity-100`
- colour opacity modifiers, which make colours the contrast tests never measured: `text-ink/60`

State variants such as `data-[state=open]:` stay allowed.

## Test

`pnpm --filter @drefyn/lint-rules test`
