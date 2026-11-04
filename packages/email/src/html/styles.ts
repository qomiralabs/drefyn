import { MAIL_PALETTE } from './palette.ts';

const { light: L, dark: D } = MAIL_PALETTE;

const DARK_RULES = [
  `.dr-bg{background-color:${D.ground}!important}`,
  `.dr-ink{color:${D.ink}!important}`,
  `.dr-body{color:${D.body}!important}`,
  `.dr-sec{color:${D.secondary}!important}`,
  `.dr-rule{border-color:${D.rule}!important}`,
  `.dr-gutter{border-color:${D.ink}!important}`,
  `.dr-link{color:${D.accent}!important}`,
];

// Outlook.com marks what it recolours with data-ogsc and data-ogsb; these put our own dark
// palette back instead of its guess.
const OUTLOOK_RULES = DARK_RULES.map((rule) =>
  rule.includes('background') ? `[data-ogsb] ${rule}` : `[data-ogsc] ${rule}`,
);

// Only phone sizes and dark mode live here. Every colour and size is also inline, so a client
// that strips this block still shows a complete, legible mail.
export const MAIL_CSS = [
  ':root{color-scheme:light dark;supported-color-schemes:light dark}',
  'body{margin:0!important;padding:0!important;width:100%!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}',
  'a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important}',
  `a:focus-visible{outline:2px solid ${L.accent};outline-offset:2px}`,
  '@media only screen and (max-width:480px){.dr-wrap{padding:24px 16px 32px!important}.dr-h1{font-size:24px!important}.dr-code{font-size:32px!important}}',
  `@media (prefers-color-scheme:dark){${DARK_RULES.join('')}a:focus-visible{outline-color:${D.accent}!important}}`,
  ...OUTLOOK_RULES,
].join('\n');
