import type { Decorator, Preview } from '@storybook/react-vite';
import './preview.css';

type Theme = 'light' | 'dark';

// Sets the theme the way an app does, on <html>, so stories use the real token
// selectors rather than a wrapper class.
const withTheme: Decorator = (Story, context) => {
  const theme: Theme = context.globals['theme'] === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset['theme'] = theme;
  return <Story />;
};

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
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
};

export default preview;
