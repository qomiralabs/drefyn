import tailwindcss from '@tailwindcss/vite';
import type { StorybookConfig } from '@storybook/react-vite';
import react from '@vitejs/plugin-react';
import { mergeConfig } from 'vite';

const config: StorybookConfig = {
  stories: ['../stories/**/*.stories.tsx'],
  addons: ['@storybook/addon-docs'],
  framework: { name: '@storybook/react-vite', options: {} },
  // Nothing leaves a contributor's machine or CI.
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
  viteFinal: (vite) =>
    mergeConfig(vite, {
      plugins: [react(), tailwindcss()],
      build: {
        // Storybook's own manager and docs chunks pass Vite's 500 KB default on their own.
        // The static build is a review artifact that nobody loads over a slow link, and
        // component sizes are measured per component elsewhere.
        chunkSizeWarningLimit: 1200,
      },
    }),
};

export default config;
