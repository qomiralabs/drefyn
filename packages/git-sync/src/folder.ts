import { err, ok, type Result } from './types.ts';

export const FOLDER_MAX_CHARS = 1024;
export const PATH_MAX_CHARS = 4096;

// Control characters and backslash. A backslash is a separator to some tools and a plain
// character to git, so a folder holding one could mean two places.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u001f\u007f\\]/;

// A repository relative path: no leading or trailing slash, no empty, '.' or '..' segment.
function isRelativePath(value: string): boolean {
  if (FORBIDDEN.test(value)) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

// '' is the repository root. Anything else must stay inside the repository as written, so a
// folder is refused rather than normalised: what a person typed is what we bind.
export function parseFolder(input: unknown): Result<string, 'git_sync.folder_unsafe'> {
  if (typeof input !== 'string' || input.length > FOLDER_MAX_CHARS) {
    return err('git_sync.folder_unsafe');
  }
  if (input === '') return ok(input);
  return isRelativePath(input) ? ok(input) : err('git_sync.folder_unsafe');
}

// Whether a repository path is a safe file path inside the bound folder.
export function isPathInFolder(path: string, folder: string): boolean {
  if (path.length === 0 || path.length > PATH_MAX_CHARS || !isRelativePath(path)) return false;
  return folder === '' || path.startsWith(`${folder}/`);
}
