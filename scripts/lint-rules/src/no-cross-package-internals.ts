import { dirname, isAbsolute, resolve } from 'node:path';
import type { Rule } from 'eslint';
import { moduleReferences } from './references.ts';
import {
  cachedWorkspace,
  declaredDependencies,
  exportEntries,
  ownerOf,
  workspaceRootFor,
  type WorkspacePackage,
} from './workspace.ts';

const SCOPED = /^(@drefyn\/[^/]+)(\/.+)?$/;

const isRelative = (spec: string) =>
  spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../');

// The package a relative path names after its last node_modules segment, if any.
// Those folders are pnpm links, so the path text sits in the importer while Node loads
// the linked package's files; following the link by name avoids realpath, which also
// rewrites symlinked roots such as /var on macOS and would then match no package.
function linkedName(spec: string): string | undefined {
  const parts = spec.split('/');
  const at = parts.lastIndexOf('node_modules');
  if (at === -1) return undefined;
  const [first = '', second = ''] = parts.slice(at + 1);
  return first.startsWith('@') ? `${first}/${second}` : first;
}

const isApp = (pkg: WorkspacePackage) => pkg.rel.startsWith('apps/');

export const noCrossPackageInternals: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Import other workspace packages only through their public entry points' },
    schema: [],
    messages: {
      internal: "'{{spec}}' reaches into {{pkg}} internals. Import from '{{pkg}}' instead.",
      app: "'{{spec}}' reaches into {{pkg}}, which is an app. Apps are never imported; move the shared code into a package.",
      linked: "'{{spec}}' goes through node_modules. Import the package by name.",
      unexported: "'{{spec}}' is not an entry point of {{pkg}}. Public entry points: {{entries}}.",
      undeclared:
        "'{{pkg}}' is not a declared dependency of {{importer}}. Add it with workspace:*.",
    },
  },
  create(context) {
    const file = context.filename;
    if (!isAbsolute(file)) return {};
    const root = workspaceRootFor(file, context.settings);
    if (root === undefined) return {};
    const workspace = cachedWorkspace(root);
    const here = ownerOf(workspace, file);
    const manifest = here?.manifest ?? workspace.rootManifest;
    const rootName = workspace.rootManifest['name'];
    const importer = here
      ? (here.name ?? here.rel)
      : typeof rootName === 'string'
        ? rootName
        : 'the root package';
    const declared = declaredDependencies(manifest);

    // Anything that is neither relative nor @drefyn/ (builtins, URLs, #imports, absolute
    // paths, npm packages) is left to Node, tsc and the exports maps.
    return moduleReferences(({ spec, loc }) => {
      if (isRelative(spec)) {
        const name = linkedName(spec);
        const target =
          name === undefined
            ? ownerOf(workspace, resolve(dirname(file), spec))
            : workspace.packages.find((candidate) => candidate.name === name);
        if (target !== undefined && target !== here) {
          const pkg = target.name ?? target.rel;
          context.report({
            loc,
            messageId: isApp(target) ? 'app' : 'internal',
            data: { spec, pkg },
          });
        } else if (name !== undefined) {
          context.report({ loc, messageId: 'linked', data: { spec } });
        }
        return;
      }
      const match = SCOPED.exec(spec);
      const pkg = match?.[1];
      if (pkg === undefined) return;
      if (pkg !== importer && !declared.has(pkg)) {
        context.report({ loc, messageId: 'undeclared', data: { pkg, importer } });
      }
      const sub = match?.[2];
      const target = workspace.packages.find((candidate) => candidate.name === pkg);
      if (sub === undefined || target === undefined) return;
      const entries = exportEntries(target.manifest['exports']);
      const keys = typeof entries === 'string' ? [] : entries.map(([key]) => key);
      if (keys.includes(`.${sub}`)) return;
      const listed = keys.map((key) => (key === '.' ? pkg : pkg + key.slice(1))).join(', ');
      context.report({
        loc,
        messageId: 'unexported',
        data: { spec, pkg, entries: listed || 'none' },
      });
    });
  },
};
