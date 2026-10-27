import { DocsContainer, type DocsContainerProps } from '@storybook/addon-docs/blocks';
import type { Decorator, Preview } from '@storybook/react-vite';
import type { PropsWithChildren } from 'react';
import { create } from 'storybook/theming';
import { tokens } from '../src/index.ts';
import './preview.css';

type Theme = 'light' | 'dark';

const themeOf = (value: unknown): Theme => (value === 'dark' ? 'dark' : 'light');

// Sets the theme the way an app does, on <html>, so stories use the real token
// selectors rather than a wrapper class.
const withTheme: Decorator = (Story, context) => {
  const theme = themeOf(context.globals['theme']);
  document.documentElement.dataset['theme'] = theme;
  return <Story />;
};

// Docs pages get one theme per mode from the token values. Storybook's docs blocks run
// colour functions on theme values, which fail on var(), so the themes hold hex. The
// container picks one from the same global the stories use and sets data-theme itself,
// so a docs page follows the switch even before any story on it renders.
function docsTheme(mode: Theme) {
  const { color, font, radius } = tokens;
  const quote = (f: string) => (f.includes(' ') ? `"${f}"` : f);
  return create({
    base: mode,
    fontBase: font.sans.map(quote).join(', '),
    fontCode: font.mono.map(quote).join(', '),
    colorPrimary: color.accent.ink[mode],
    colorSecondary: color.accent.ink[mode],
    appBg: color.surface.raised[mode],
    appContentBg: color.surface.ground[mode],
    appPreviewBg: color.surface.ground[mode],
    appHoverBg: color.surface.hover[mode],
    appBorderColor: color.border.rule[mode],
    appBorderRadius: radius.md,
    textColor: color.text.body[mode],
    textInverseColor: color.surface.ground[mode],
    textMutedColor: color.text.secondary[mode],
    barBg: color.surface.raised[mode],
    barTextColor: color.text.secondary[mode],
    barHoverColor: color.accent.ink[mode],
    barSelectedColor: color.accent.ink[mode],
    buttonBg: color.surface.ground[mode],
    buttonBorder: color.border.control[mode],
    booleanBg: color.surface.sunken[mode],
    booleanSelectedBg: color.surface.ground[mode],
    inputBg: color.surface.ground[mode],
    inputBorder: color.border.control[mode],
    inputTextColor: color.text.ink[mode],
    inputBorderRadius: radius.sm,
  });
}

const docsThemes = { light: docsTheme('light'), dark: docsTheme('dark') };

function ThemedDocs({ context, children }: PropsWithChildren<DocsContainerProps>) {
  let theme: Theme = 'light';
  try {
    const story = context.getStoryContext(context.storyById()) as {
      globals: Record<string, unknown>;
    };
    theme = themeOf(story.globals['theme']);
  } catch {
    // A docs page with no story of its own keeps the light theme.
  }
  document.documentElement.dataset['theme'] = theme;
  return (
    <DocsContainer context={context} theme={docsThemes[theme]}>
      {children}
    </DocsContainer>
  );
}

const preview: Preview = {
  decorators: [withTheme],
  globalTypes: {
    theme: {
      description: 'Colour mode',
      toolbar: {
        title: 'Theme',
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: 'light' },
  parameters: { layout: 'fullscreen', docs: { container: ThemedDocs } },
  tags: ['autodocs'],
};

export default preview;
