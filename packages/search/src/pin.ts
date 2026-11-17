// Which line and language of a site a public search reads. Both values reach a Typesense filter,
// so only shapes that need no escaping get through.

declare const versionBrand: unique symbol;
declare const localeBrand: unique symbol;

export type DocsVersionKey = string & { readonly [versionBrand]: true };
export type LocaleTag = string & { readonly [localeBrand]: true };

export interface SearchPin {
  readonly version: DocsVersionKey;
  readonly locale: LocaleTag;
}

export const LATEST = 'latest' as DocsVersionKey;
export const DEFAULT_LOCALE = 'default' as LocaleTag;

const VERSION_KEY = /^[a-z0-9][a-z0-9.-]{0,31}$/;
// Canonical BCP 47 is letters, digits and hyphens; anything past 35 characters is not a tag
// any site would publish under.
const LOCALE_SHAPE = /^[A-Za-z0-9-]{2,35}$/;

export function parseVersionKey(raw: unknown): DocsVersionKey | null {
  if (typeof raw !== 'string' || !VERSION_KEY.test(raw)) return null;
  return raw as DocsVersionKey;
}

// Canonical case, so en-us and en-US name the same documents.
export function parseLocaleTag(raw: unknown): LocaleTag | null {
  if (typeof raw !== 'string') return null;
  if (raw === DEFAULT_LOCALE) return DEFAULT_LOCALE;
  if (!LOCALE_SHAPE.test(raw)) return null;
  let canonical: string | undefined;
  try {
    [canonical] = Intl.getCanonicalLocales(raw);
  } catch {
    return null;
  }
  if (canonical === undefined || !LOCALE_SHAPE.test(canonical)) return null;
  return canonical as LocaleTag;
}

// Missing values read as the latest line in the site's default language.
export function parseSearchPin(input: {
  readonly version?: unknown;
  readonly locale?: unknown;
}): SearchPin | null {
  const version = input.version === undefined ? LATEST : parseVersionKey(input.version);
  const locale = input.locale === undefined ? DEFAULT_LOCALE : parseLocaleTag(input.locale);
  if (version === null || locale === null) return null;
  return Object.freeze({ version, locale });
}
