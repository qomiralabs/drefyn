import type * as Email from '@drefyn/email';

// The one line that loads mail code. Next refuses react-dom/server in its server graph, so
// this import is left for Node to resolve at run time and no bundler ever sees the package.
export function loadEmail(): Promise<typeof Email> {
  return import(/* turbopackIgnore: true */ /* webpackIgnore: true */ '@drefyn/email');
}
