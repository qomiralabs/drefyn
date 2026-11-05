import { z } from 'zod';

const color = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const radius = z.string().regex(/^[0-9]{1,2}px$/);
// Names and quotes only. No brackets means no url(), so a stack can never fetch a font.
const stack = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9 ,"'-]+$/);

// An allow list, so state colours stay locked: no theme can paint a broken state green.
const values = z.strictObject({
  '--dr-surface-ground': color.exactOptional(),
  '--dr-surface-raised': color.exactOptional(),
  '--dr-surface-sunken': color.exactOptional(),
  '--dr-text-ink': color.exactOptional(),
  '--dr-text-body': color.exactOptional(),
  '--dr-text-secondary': color.exactOptional(),
  '--dr-accent-ink': color.exactOptional(),
  '--dr-font-sans': stack.exactOptional(),
  '--dr-font-mono': stack.exactOptional(),
  '--dr-radius-sm': radius.exactOptional(),
  '--dr-radius-md': radius.exactOptional(),
});

export type ThemeToken = keyof z.infer<typeof values>;
export type ThemeValues = Readonly<Partial<Record<ThemeToken, string>>>;

export interface ThemeTokens {
  readonly light?: ThemeValues;
  readonly dark?: ThemeValues;
}

export const themeSchema = z.strictObject({
  light: values.exactOptional(),
  dark: values.exactOptional(),
});

function declarations(theme: ThemeValues | undefined): string {
  return Object.entries(theme ?? {})
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, value]) => `${name}:${value}`)
    .join(';');
}

// The dark selectors match the token stylesheet's own, or a theme would lose to them.
export function themeCss(theme: ThemeTokens): string {
  const light = declarations(theme.light);
  const dark = declarations(theme.dark);
  return [
    light === '' ? '' : `:root{${light}}`,
    dark === ''
      ? ''
      : `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${dark}}}:root[data-theme="dark"]{${dark}}`,
  ].join('');
}
