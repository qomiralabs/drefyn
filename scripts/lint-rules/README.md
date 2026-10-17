# @drefyn/lint-rules

In repo ESLint rules, registered in the root `eslint.config.js` as the `drefyn` plugin.

## drefyn/no-arbitrary-values

On for `packages/ui` and `apps/*`. Reports any string that holds a Tailwind class which mints a
value outside the tokens:

- arbitrary values and properties: `p-[13px]`, `text-[#ff0000]`, `p-(--x)`, `[mask-type:alpha]`
- arbitrary breakpoints: `min-[700px]:p-16`
- raw durations, which skip reduced motion: `duration-200`
- colour opacity modifiers, which make colours the contrast tests never measured: `text-ink/60`

State variants such as `data-[state=open]:` stay allowed.

## Test

`pnpm --filter @drefyn/lint-rules test`
