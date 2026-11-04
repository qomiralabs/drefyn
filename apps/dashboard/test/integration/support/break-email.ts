import { registerHooks } from 'node:module';

// Loaded with --import: stands in for an image that shipped without the mail package.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@drefyn/email') throw new Error('Cannot find package');
    return nextResolve(specifier, context);
  },
});
