import { tokens } from '@drefyn/ui';

const c = tokens.color;

const scheme = (mode: 'light' | 'dark') => ({
  ground: c.surface.ground[mode],
  ink: c.text.ink[mode],
  body: c.text.body[mode],
  // The faintest text in mail. Subtle stays out: some clients put a tinted ground behind it.
  secondary: c.text.secondary[mode],
  rule: c.border.rule[mode],
  accent: c.accent.ink[mode],
});

export const MAIL_PALETTE = { light: scheme('light'), dark: scheme('dark') } as const;

export const MAIL_TEXT_ROLES = ['ink', 'body', 'secondary', 'accent'] as const;

// No web fonts. Inter and JetBrains Mono show only where they are installed, and everyone
// else gets the platform face.
export const SANS = [
  tokens.font.sans[0],
  '-apple-system',
  'BlinkMacSystemFont',
  "'Segoe UI'",
  'Roboto',
  'Helvetica',
  'Arial',
  'sans-serif',
].join(',');

export const MONO = [
  `'${tokens.font.mono[0]}'`,
  'ui-monospace',
  "'SF Mono'",
  'SFMono-Regular',
  'Menlo',
  'Consolas',
  "'Liberation Mono'",
  'monospace',
].join(',');
