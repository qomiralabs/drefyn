import { parseDocument } from 'yaml';

// Same cap the yaml package applies by default, written here so an upgrade cannot widen it.
const MAX_ALIASES = 100;

// Core schema only. Custom tags are how YAML loaders end up building objects or running code.
export function isValidFrontmatter(text: string): boolean {
  try {
    const document = parseDocument(text, { schema: 'core', logLevel: 'silent' });
    if (document.errors.length > 0 || document.warnings.length > 0) return false;
    // Alias bombs only go off on expansion, so expand under the cap to find them.
    document.toJS({ maxAliasCount: MAX_ALIASES });
    return true;
  } catch {
    return false;
  }
}
