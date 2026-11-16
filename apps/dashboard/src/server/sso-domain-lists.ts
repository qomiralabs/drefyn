import {
  createSsoDomainPolicy,
  loadFreeMailDomains,
  loadPublicSuffixList,
  type PublicSuffixList,
  type SsoDomainPolicy,
} from '@drefyn/auth';
import { configErrorFields } from './boot.ts';

export interface ListDeps {
  // The snapshot shipped in packages/auth/data, found from the auth module's own path.
  readonly loadSuffixes?: () => Promise<PublicSuffixList>;
  readonly loadFreeMail?: (path: string) => Promise<readonly string[]>;
}

interface Loaded {
  readonly policy: SsoDomainPolicy;
  readonly publicSuffixes: number;
  readonly extraFreeMail: number;
}

// A global under a registered symbol, because server.ts and each Next layer load separate
// copies of this module, and the list is read once per process.
const HOLDER = Symbol.for('drefyn.sso_domain_lists');
const global = globalThis as unknown as Record<
  symbol,
  { lists?: Promise<Loaded> | undefined } | undefined
>;
const holder = () => (global[HOLDER] ??= {});

async function load(file: string | null, deps: ListDeps): Promise<Loaded> {
  const suffixes = await (deps.loadSuffixes ?? (() => loadPublicSuffixList()))();
  const extra = file === null ? [] : await (deps.loadFreeMail ?? loadFreeMailDomains)(file);
  return Object.freeze({
    policy: createSsoDomainPolicy({ publicSuffixes: suffixes, extraFreeMail: extra }),
    publicSuffixes: suffixes.size,
    extraFreeMail: extra.length,
  });
}

function loaded(file: string | null, deps: ListDeps): Promise<Loaded> {
  const held = holder();
  held.lists ??= load(file, deps).catch((error: unknown) => {
    held.lists = undefined;
    throw error;
  });
  return held.lists;
}

// What a domain claim is checked against. The file is the one the auth config names; the
// first load in a process wins.
export async function ssoDomainPolicy(
  file: string | null,
  deps: ListDeps = {},
): Promise<SsoDomainPolicy> {
  return (await loaded(file, deps)).policy;
}

// For tests, which load different lists in one process.
export function forgetSsoDomainPolicy(): void {
  holder().lists = undefined;
}

export interface ListCheck {
  readonly file: string | null;
  readonly exit: (code: number) => void;
  readonly log: (event: string, context: Record<string, string | number>) => void;
  readonly deps?: ListDeps;
}

// At start, so a build that left the data folder behind or a bad extra file stops the
// server instead of letting a public suffix or a mail provider be claimed later. The error
// is reduced to its code and key, since its text can hold a path or a line of the file.
export async function checkSsoDomainLists(check: ListCheck): Promise<void> {
  try {
    const { publicSuffixes, extraFreeMail } = await loaded(check.file, check.deps ?? {});
    check.log('dashboard.sso_lists_loaded', { publicSuffixes, extraFreeMail });
  } catch (error) {
    check.log('dashboard.config_invalid', configErrorFields(error));
    check.exit(1);
  }
}
