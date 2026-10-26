import { addons } from 'storybook/manager-api';
import { create } from 'storybook/theming';
import { tokens } from '../src/index.ts';

// The manager chrome takes its type and colours from the light tokens, so the frame
// around a story reads as ours and not as the library's default.
const { color, font } = tokens;

addons.setConfig({
  // No addon panel is in use, so the story gets the whole width.
  showPanel: false,
  theme: create({
    base: 'light',
    brandTitle: 'Drefyn UI',
    fontBase: font.sans.map((f) => (f.includes(' ') ? `"${f}"` : f)).join(', '),
    fontCode: font.mono.map((f) => (f.includes(' ') ? `"${f}"` : f)).join(', '),
    colorPrimary: color.accent.ink.light,
    colorSecondary: color.accent.ink.light,
    appBg: color.surface.raised.light,
    appContentBg: color.surface.ground.light,
    appPreviewBg: color.surface.ground.light,
    appBorderColor: color.border.rule.light,
    textColor: color.text.body.light,
    textMutedColor: color.text.secondary.light,
    barBg: color.surface.ground.light,
    barTextColor: color.text.secondary.light,
    barSelectedColor: color.accent.ink.light,
    inputBg: color.surface.ground.light,
    inputBorder: color.border.control.light,
    inputTextColor: color.text.ink.light,
  }),
});
