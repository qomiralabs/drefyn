import { dirname, isAbsolute, resolve } from 'node:path';
import type { Rule } from 'eslint';
import { moduleReferences } from './references.ts';
import {
  cachedWorkspace,
  declaredDependencies,
  exportKeys,
  findWorkspaceRoot,
  ownerOf,
} from './workspace.ts';

const SCOPED = /^(@drefyn\/[^/]+)(\/.+)?$/;

const isRelative = (spec: string) =>
  spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../');

export const noCrossPackageInternals: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Import other workspace packages only through their public entry points' },
    schema: [],
    messages: {
      internal: "'{{spec}}' reaches into {{pkg}} internals. Import from '{{pkg}}' instead.",
      unexported: "'{{spec}}' is not an entry point of {{pkg}}. Public entry points: {{entries}}.",
      undeclared:
        "'{{pkg}}' is not a declared dependency of {{importer}}. Add it with workspace:*.",
    },
  },
  create(context) {
    const file = context.filename;
    if (!isAbsolute(file)) return {};
    const root = findWorkspaceRoot(dirname(file));
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
        const target = ownerOf(workspace, resolve(dirname(file), spec));
        if (target !== undefined && target !== here) {
          context.report({
            loc,
            messageId: 'internal',
            data: { spec, pkg: target.name ?? target.rel },
          });
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
      const keys = exportKeys(target.manifest['exports']);
      if (keys.includes(`.${sub}`)) return;
      const entries = keys.map((key) => (key === '.' ? pkg : pkg + key.slice(1))).join(', ');
      context.report({
        loc,
        messageId: 'unexported',
        data: { spec, pkg, entries: entries || 'none' },
      });
    });
  },
};
