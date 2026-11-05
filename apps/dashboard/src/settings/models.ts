import { API_KEY_SCOPES } from '@drefyn/auth/permissions';
import type { OrgRole } from '@drefyn/auth/permissions';

// Pure view models for the settings pages. No words here depend on a plan: every seat number
// arrives from entitlements, and these only say it.

export type Product = 'docs' | 'studio' | 'status';
export const PRODUCT_LABELS: Readonly<Record<Product, string>> = {
  docs: 'Docs',
  studio: 'Studio',
  status: 'Status',
};
const PRODUCTS = Object.keys(PRODUCT_LABELS) as readonly Product[];

const ROLE_LABELS: Readonly<Record<OrgRole, string>> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};
export const roleLabel = (role: OrgRole): string => ROLE_LABELS[role];

export const ROLE_DESCRIPTIONS: Readonly<Record<OrgRole, string>> = {
  owner: 'Everything, including billing and deleting the organization.',
  admin: 'Manages people, API keys, settings and every project.',
  member: 'Works in the projects you give them.',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

// UTC, so the server's words and the browser's are the same and the page says which clock.
export function dayWords(iso: string, withYear = false): string {
  const at = new Date(iso);
  const day = `${String(at.getUTCDate())} ${MONTHS[at.getUTCMonth()] ?? ''}`;
  return withYear ? `${day} ${String(at.getUTCFullYear())}` : day;
}

const utcDay = (at: Date) => Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());

export function usedWords(iso: string | null, now: string): string {
  if (iso === null) return 'Never';
  const at = new Date(iso);
  const days = Math.round((utcDay(new Date(now)) - utcDay(at)) / DAY_MS);
  if (days === 0) {
    const hours = String(at.getUTCHours()).padStart(2, '0');
    const minutes = String(at.getUTCMinutes()).padStart(2, '0');
    return `Today, ${hours}:${minutes} UTC`;
  }
  return days === 1 ? 'Yesterday' : dayWords(iso);
}

export const plural = (count: number, one: string, many = `${one}s`): string =>
  `${String(count)} ${count === 1 ? one : many}`;

export type SeatState = 'room' | 'full' | 'over';

export interface Seats {
  readonly used: number;
  readonly limit: number | null;
  readonly words: string;
  readonly state: SeatState;
}

export function seatsFrom(usage: { used: number; limit: number | 'unlimited' }): Seats {
  const { used, limit } = usage;
  if (limit === 'unlimited') {
    return { used, limit: null, words: `${String(used)} used`, state: 'room' };
  }
  const state: SeatState = used > limit ? 'over' : used === limit ? 'full' : 'room';
  return { used, limit, words: `${String(used)} of ${String(limit)}`, state };
}

function restFor(seats: Seats): string {
  if (seats.limit === null) return `${plural(seats.used, 'seat')} used.`;
  if (seats.state === 'over') return `${seats.words} seats used, so new invitations are paused.`;
  if (seats.state === 'full') return `All ${String(seats.limit)} seats are used.`;
  return `${seats.words} seats used.`;
}

export function seatSentence(
  organization: string,
  people: number,
  waiting: number,
  seats: Seats,
): { readonly claim: string; readonly rest: string } {
  const who = `${plural(people, 'person', 'people')} in ${organization}`;
  const claim = waiting === 0 ? `${who}.` : `${who}, ${plural(waiting, 'invitation')} waiting.`;
  return { claim, rest: restFor(seats) };
}

export type InvitePermit =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

export function invitePermit(seats: Seats): InvitePermit {
  if (seats.state === 'room') return { allowed: true };
  const limit = String(seats.limit);
  if (seats.state === 'full') {
    return {
      allowed: false,
      reason: `All ${limit} seats are used. Withdraw an invitation, remove someone, or change the plan to invite more.`,
    };
  }
  return {
    allowed: false,
    reason: `New invitations are paused until ${limit} or fewer are used. Change the plan, or remove people who no longer need access.`,
  };
}

export type LastUsed = 'any' | '7d' | '30d' | 'never';
export type KeyCreator = string;

export interface KeyFilters {
  readonly search?: string;
  readonly products: readonly Product[];
  readonly createdBy: readonly KeyCreator[];
  readonly lastUsed: LastUsed;
  readonly cursor?: string;
}

const SEARCH_MAX = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LAST_USED: ReadonlySet<string> = new Set(['any', '7d', '30d', 'never']);

type Params = Readonly<Record<string, string | readonly string[] | undefined>>;
const one = (value: string | readonly string[] | undefined) =>
  typeof value === 'string' ? value : '';
const listOf = (value: string | readonly string[] | undefined) =>
  one(value)
    .split(',')
    .filter((part) => part !== '');

// A URL is typed by anyone, so what is not understood is dropped, and the page still shows.
export function keyFiltersFrom(params: Params): KeyFilters {
  const search = Array.from(one(params['q']).trim()).slice(0, SEARCH_MAX).join('');
  const used = one(params['used']);
  const cursor = one(params['after']);
  return {
    ...(search === '' ? {} : { search }),
    products: listOf(params['can']).filter((p): p is Product =>
      (PRODUCTS as readonly string[]).includes(p),
    ),
    createdBy: listOf(params['by'])
      .filter((by) => by === 'former' || UUID.test(by))
      .slice(0, 50),
    lastUsed: LAST_USED.has(used) ? (used as LastUsed) : 'any',
    ...(cursor === '' ? {} : { cursor }),
  };
}

// Any change of filter starts again from the first page.
export function firstPage(filters: KeyFilters): KeyFilters {
  return {
    ...(filters.search === undefined ? {} : { search: filters.search }),
    products: filters.products,
    createdBy: filters.createdBy,
    lastUsed: filters.lastUsed,
  };
}

// The list refuses an empty filter rather than reading it as none, so unset ones stay out.
export function keyListInput(filters: KeyFilters): {
  readonly search?: string;
  readonly products?: readonly Product[];
  readonly createdBy?: readonly KeyCreator[];
  readonly lastUsed: LastUsed;
  readonly cursor?: string;
} {
  const { search, products, createdBy, lastUsed, cursor } = filters;
  return {
    ...(search === undefined ? {} : { search }),
    ...(products.length === 0 ? {} : { products }),
    ...(createdBy.length === 0 ? {} : { createdBy }),
    lastUsed,
    ...(cursor === undefined ? {} : { cursor }),
  };
}

export function keyFilterSearch(filters: KeyFilters): string {
  const query = new URLSearchParams();
  if (filters.search !== undefined && filters.search !== '') query.set('q', filters.search);
  if (filters.products.length > 0) query.set('can', filters.products.join(','));
  if (filters.createdBy.length > 0) query.set('by', filters.createdBy.join(','));
  if (filters.lastUsed !== 'any') query.set('used', filters.lastUsed);
  if (filters.cursor !== undefined) query.set('after', filters.cursor);
  const text = query.toString().replaceAll('%2C', ',');
  return text === '' ? '' : `?${text}`;
}

// A revoked key stays listed, so it reads as over at a glance. Secondary rather than the
// disabled ink, so its row is still read as easily as any other.
export function keyRowTone(state: 'live' | 'expired' | 'revoked'): {
  readonly row: string | undefined;
  readonly name: string;
} {
  return state === 'revoked'
    ? { row: 'bg-sunken text-secondary', name: 'text-secondary' }
    : { row: undefined, name: 'text-ink' };
}

export const needsTypedName = (lastUsedAt: string | null, now: string): boolean =>
  lastUsedAt !== null && new Date(now).getTime() - new Date(lastUsedAt).getTime() <= WEEK_MS;

const SCOPE_LABELS = new Map(API_KEY_SCOPES.map((s) => [s.scope, s.label]));

// "Read pages" and "Publish pages" read as one sentence when they share their last word.
export function scopeWords(scopes: readonly string[]): string {
  const labels = scopes.map((scope) => SCOPE_LABELS.get(scope) ?? scope);
  const [first, second] = labels;
  if (labels.length === 2 && first !== undefined && second !== undefined) {
    const [verb, ...tail] = first.split(' ');
    const [otherVerb, ...otherTail] = second.split(' ');
    if (tail.length > 0 && tail.join(' ') === otherTail.join(' ')) {
      return `${verb ?? ''} and ${(otherVerb ?? '').toLowerCase()} ${tail.join(' ')}`;
    }
  }
  return labels.map((label, index) => (index === 0 ? label : label.toLowerCase())).join(', ');
}

export function projectWords(
  scope: 'all' | 'listed',
  ids: readonly string[],
  names: Readonly<Record<string, string>>,
): string {
  if (scope === 'all') return 'All projects';
  const [only] = ids;
  if (ids.length === 1 && only !== undefined) return names[only] ?? '1 project';
  return plural(ids.length, 'project');
}

export interface PersonRow {
  readonly id: string;
  readonly kind: 'member' | 'invited' | 'expired';
  readonly name: string;
  readonly email: string;
  readonly role: OrgRole;
  readonly at: string;
}

export type PeopleStatus = 'active' | 'invited' | 'expired';
export type PeopleSort = 'name' | 'role' | 'newest' | 'oldest';

export interface PeopleFilter {
  readonly search: string;
  readonly roles: readonly OrgRole[];
  readonly statuses: readonly PeopleStatus[];
  readonly sort: PeopleSort;
}

const STATUS_OF: Readonly<Record<PersonRow['kind'], PeopleStatus>> = {
  member: 'active',
  invited: 'invited',
  expired: 'expired',
};
const ROLE_ORDER: readonly OrgRole[] = ['owner', 'admin', 'member'];

const SORTS: Readonly<Record<PeopleSort, (a: PersonRow, b: PersonRow) => number>> = {
  name: (a, b) => a.name.localeCompare(b.name, 'en'),
  role: (a, b) =>
    ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.name.localeCompare(b.name, 'en'),
  newest: (a, b) => b.at.localeCompare(a.at),
  oldest: (a, b) => a.at.localeCompare(b.at),
};

export function filterPeople<T extends PersonRow>(rows: readonly T[], filter: PeopleFilter): T[] {
  const needle = filter.search.trim().toLowerCase();
  return rows
    .filter(
      (row) =>
        (needle === '' ||
          row.name.toLowerCase().includes(needle) ||
          row.email.toLowerCase().includes(needle)) &&
        (filter.roles.length === 0 || filter.roles.includes(row.role)) &&
        filter.statuses.includes(STATUS_OF[row.kind]),
    )
    .toSorted(SORTS[filter.sort]);
}

export interface RoleOption {
  readonly role: OrgRole;
  readonly reason?: string;
}

// Every role stays in the list; one that cannot be chosen says why.
export function roleOptions(
  facts: {
    readonly actor: OrgRole;
    readonly target: OrgRole;
    readonly self: boolean;
    readonly lastOwner: boolean;
  },
  organization = 'This organization',
): readonly RoleOption[] {
  return ROLE_ORDER.map((role) => {
    if (facts.lastOwner && role !== 'owner') {
      return {
        role,
        reason: `${organization} needs at least one owner. Make someone else an owner first.`,
      };
    }
    if (role === 'owner' && facts.actor !== 'owner') {
      return { role, reason: 'Only an owner can make someone an owner.' };
    }
    if (facts.self && ROLE_ORDER.indexOf(role) < ROLE_ORDER.indexOf(facts.target)) {
      return { role, reason: 'Nobody can raise their own role.' };
    }
    return { role };
  });
}

const capitalised = (word: string) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

export function projectAccessWords(
  role: OrgRole,
  fallback: 'editor' | 'viewer' | null,
  overrides: readonly string[],
): string {
  if (role !== 'member') return 'Admin on all';
  if (fallback !== null) {
    const base = `${capitalised(fallback)} on all`;
    const [only] = overrides;
    if (overrides.length === 0 || only === undefined) return base;
    const same = overrides.every((role) => role === only);
    return same
      ? `${base}, ${only} on ${String(overrides.length)}`
      : `${base}, ${plural(overrides.length, 'project')} set`;
  }
  return overrides.length === 0 ? 'No projects yet' : plural(overrides.length, 'project');
}

export interface MethodFacts {
  readonly passwordSetAt: string | null;
  readonly identities: readonly {
    readonly provider: 'github' | 'google';
    readonly account: string;
    readonly linkedAt: string;
  }[];
}

export function methodsFrom(
  facts: MethodFacts,
  emailOn: boolean,
): { readonly count: number; readonly only: boolean } {
  const count =
    (emailOn ? 1 : 0) + (facts.passwordSetAt === null ? 0 : 1) + facts.identities.length;
  return { count, only: count <= 1 };
}

export interface StepUpFacts {
  readonly password: boolean;
  readonly email: boolean;
  readonly google: boolean;
  readonly github: boolean;
}

export type StepUpWay = 'password' | 'email' | 'google' | 'github';

// GitHub proves only a live GitHub session, so it counts only when nothing else exists.
export function stepUpWays(facts: StepUpFacts): readonly StepUpWay[] {
  const ways: StepUpWay[] = [];
  if (facts.password) ways.push('password');
  if (facts.email) ways.push('email');
  if (facts.google) ways.push('google');
  return ways.length === 0 && facts.github ? ['github'] : ways;
}
