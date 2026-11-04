// Each allowance names one raw form a scoped entry may use. Anything not listed stays
// reported in that file, so an exception is exactly as wide as the need.
export type EgressAllowance =
  | { readonly module: 'node:http'; readonly imports: readonly ['createServer'] }
  | { readonly global: 'fetch' };

export interface EgressAllowEntry {
  readonly path: string;
  readonly reason: string;
  readonly only?: readonly EgressAllowance[];
}

// Paths are compared as text with a path built from the workspace root, so any other spelling
// (./a, a/./b, a//b, a\\b) would pass review and then match nothing. Trailing slash for a folder.
export const ALLOW_PATH_PATTERN = '^(?!/)(?!.*\\\\)(?!.*//)(?!.*(^|/)\\.{1,2}(/|$)).+$';
const ALLOW_PATH = new RegExp(ALLOW_PATH_PATTERN);

const SOURCE_EXTENSIONS = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

// The rules JSON schema cannot express. A scoped directory entry would quietly extend
// to every file added under it later. Apps serve customers directly, so an app file
// gets only the forms it names, never a whole file pass.
export function allowListProblems(entries: readonly EgressAllowEntry[]): string[] {
  const problems: string[] = [];
  for (const { path, only } of entries) {
    if (!ALLOW_PATH.test(path)) {
      problems.push(
        `allow list entry '${path}': write a plain path from the workspace root, with forward slashes`,
      );
    }
    if (only !== undefined && (path.endsWith('/') || !SOURCE_EXTENSIONS.test(path))) {
      problems.push(
        `allow list entry '${path}': an entry with only must name one source file, not a directory`,
      );
    }
    if (only === undefined && (path === 'apps' || path.startsWith('apps/'))) {
      problems.push(
        `allow list entry '${path}': entries under apps/ must list the forms they need in only`,
      );
    }
  }
  return problems;
}
