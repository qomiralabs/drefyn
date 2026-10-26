export type Verdict = 'approve' | 'changes_requested';

export interface Marker {
  reviewer: string;
  sha: string;
  verdict: Verdict;
}

// One submitted PR review. Issue comments are not a marker source: they can be deleted
// without trace, and a submitted review cannot.
export interface Review {
  author: string;
  // The GraphQL __typename of the author. Bot logins come back without the [bot] suffix,
  // so a bot could otherwise match a listed user's login.
  authorType: string;
  // Kept for the report only. The Actions token cannot see private org membership, so
  // this says CONTRIBUTOR for members and is no signal of trust.
  authorAssociation?: string;
  submittedAt: string;
  body: string;
  // Anyone with write access can edit someone else's review, and the author stays the
  // same, so an edited body is not evidence of what its author decided.
  edited?: boolean;
  dismissed?: boolean;
}

export interface GateInput {
  headSha: string;
  labels: string[];
  files: string[];
  reviews: Review[];
  // Commits other than the head whose approvals still count, because the head reaches
  // each of them only through clean merges of the base branch.
  carry?: string[];
  // Why the carry set ends where it does, for the report.
  carryNote?: string;
}

// A path matches when any one of these does. All comparisons ignore case.
export interface Matcher {
  // A segment that is exactly * stands for any one segment, so packages/*/test/ means a
  // test directory at a package root and nowhere deeper.
  prefixes: string[];
  // The last path segment, exactly.
  names: string[];
  contains: string[];
  suffixes: string[];
}

// Path classes, checked in this order for each file: security, tests, ui, docs.
export interface PathRules {
  security: Matcher;
  tests: Matcher;
  ui: Matcher;
  docs: Matcher;
}

export const PATH_CLASSES = ['security', 'tests', 'ui', 'docs'] as const;
export const MATCHER_FIELDS = ['prefixes', 'names', 'contains', 'suffixes'] as const;

// Which logins may sign for each reviewer name, plus the path classes.
export interface GateConfig {
  paths: PathRules;
  reviewers: Record<string, string[]>;
}

export type Tier = 'A' | 'B' | 'C';

export interface Requirement {
  reviewer: string;
  reason: string;
}

export type ReviewerState = 'approved' | 'changes_requested' | 'missing' | 'no-signers';

export interface ReviewerResult {
  reviewer: string;
  state: ReviewerState;
  reason: string;
  by?: string;
  at?: string;
  edited?: boolean;
  // Set when a block was requested on another commit than the head.
  sha?: string;
  // Set when the approval was given on an older commit and carried over base merges.
  carriedFrom?: string;
}

export type IgnoreReason =
  | 'not-last-line'
  | 'unknown-reviewer'
  | 'not-a-user'
  | 'not-allowed'
  | 'wrong-sha'
  | 'dismissed-approve';

export interface IgnoredReview {
  author: string;
  // Shown in the report because a bot can carry the same login as a listed user.
  authorType: string;
  association: string;
  submittedAt: string;
  reviewer?: string;
  reason: IgnoreReason;
}

export interface GateResult {
  pass: boolean;
  headSha: string;
  tier: Tier;
  tierReason: string;
  carried: string[];
  carryNote?: string;
  reviewers: ReviewerResult[];
  ignored: IgnoredReview[];
}

const IGNORE_TEXT: Record<IgnoreReason, string> = {
  'not-last-line': 'no valid marker on the last line',
  'unknown-reviewer': 'unknown reviewer name',
  'not-a-user': 'author is not a user account',
  'not-allowed': 'login not allowed to sign for this reviewer',
  'wrong-sha': 'approval for another SHA',
  'dismissed-approve': 'approval on a dismissed review',
};

// The reviewer floor for each tier lives here rather than in rules.json, so editing the
// rules can move a path between tiers but never drop security review from tier A.
const TIER_REVIEWERS: Record<Tier, readonly string[]> = {
  A: ['code-reviewer', 'qa-verifier', 'security-reviewer'],
  B: ['code-reviewer', 'qa-verifier'],
  C: ['code-reviewer'],
};
const LABELLED_REVIEWERS: readonly (readonly [label: string, reviewer: string])[] = [
  ['needs-security', 'security-reviewer'],
  ['needs-perf', 'performance-reviewer'],
  ['needs-design', 'design-reviewer'],
];
const ORDER = [
  'code-reviewer',
  'qa-verifier',
  'security-reviewer',
  'performance-reviewer',
  'design-reviewer',
];
export const KNOWN_REVIEWERS = new Set(ORDER);
const RANK: Record<Tier, number> = { C: 0, B: 1, A: 2 };

const MARKER =
  /^<!-- drefyn-review reviewer=([a-z][a-z-]*) sha=([0-9a-f]{40}) verdict=(approve|changes_requested) -->$/;
const SHA = /^[0-9a-f]{40}$/;
const STATUS_DESCRIPTION_LIMIT = 140;

// Only the last line counts, so a quoted or pasted marker higher up cannot approve anything.
export function parseMarker(body: string): Marker | undefined {
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  const match = MARKER.exec(lines.at(-1) ?? '');
  if (!match) return undefined;
  const [, reviewer = '', sha = '', verdict] = match;
  return { reviewer, sha, verdict: verdict === 'approve' ? 'approve' : 'changes_requested' };
}

function prefixMatches(prefix: string, path: string): boolean {
  if (!prefix.split('/').includes('*')) return path.startsWith(prefix);
  const want = prefix.split('/');
  const have = path.split('/');
  // A prefix ending in / names a directory, so the path needs at least one more segment.
  if (have.length < want.length) return false;
  return want.every((part, i) => {
    if (i === want.length - 1 && part === '') return true;
    if (part === '*') return have[i] !== '';
    return have[i] === part;
  });
}

function matches(matcher: Matcher, path: string): boolean {
  const lower = path.toLowerCase();
  const name = lower.split('/').at(-1) ?? '';
  const low = (list: string[]) => list.map((item) => item.toLowerCase());
  return (
    low(matcher.prefixes).some((prefix) => prefixMatches(prefix, lower)) ||
    low(matcher.names).includes(name) ||
    low(matcher.contains).some((part) => lower.includes(part)) ||
    low(matcher.suffixes).some((suffix) => lower.endsWith(suffix))
  );
}

// Security paths win over everything. Tests come before UI so a component test does not
// need design review, and UI before docs so copy a front end ships is still reviewed as
// product.
export function classify(file: string, paths: PathRules): { tier: Tier; ui: boolean } {
  const ui = matches(paths.ui, file);
  if (matches(paths.security, file)) return { tier: 'A', ui };
  if (matches(paths.tests, file)) return { tier: 'C', ui: false };
  if (ui) return { tier: 'B', ui };
  if (matches(paths.docs, file)) return { tier: 'C', ui: false };
  return { tier: 'B', ui: false };
}

export function tierOf(files: string[], paths: PathRules): { tier: Tier; reason: string } {
  // Nothing to classify is not evidence of a harmless change.
  if (files.length === 0) return { tier: 'A', reason: 'tier A, no changed files' };
  let tier: Tier = 'C';
  let hit: string | undefined;
  for (const file of files) {
    const next = classify(file, paths).tier;
    if (RANK[next] > RANK[tier]) {
      tier = next;
      hit = file;
    }
  }
  if (hit === undefined) return { tier, reason: 'tier C, tests and docs only' };
  return { tier, reason: `tier ${tier}, path ${hit}` };
}

export function requiredReviewers(
  labels: string[],
  files: string[],
  paths: PathRules,
): Requirement[] {
  const { tier, reason } = tierOf(files, paths);
  const required = new Map<string, string>(TIER_REVIEWERS[tier].map((r) => [r, reason]));
  if (tier !== 'C' && !required.has('design-reviewer')) {
    const ui = files.find((file) => classify(file, paths).ui);
    if (ui !== undefined) required.set('design-reviewer', `ui path ${ui}`);
  }
  // GitHub treats label names case insensitively, so the gate does too. A label can only
  // add a reviewer, since anyone who can label can also unlabel.
  const set = new Set(labels.map((label) => label.toLowerCase()));
  for (const [label, reviewer] of LABELLED_REVIEWERS) {
    if (set.has(label) && !required.has(reviewer)) required.set(reviewer, `label ${label}`);
  }
  return ORDER.flatMap((reviewer) => {
    const why = required.get(reviewer);
    return why === undefined ? [] : [{ reviewer, reason: why }];
  });
}

interface Counted {
  reviewer: string;
  verdict: Verdict;
  review: Review;
  time: number;
  sha?: string;
}

function timeOf(review: Review): number {
  const time = Date.parse(review.submittedAt);
  if (Number.isNaN(time)) {
    throw new Error(
      `unreadable timestamp ${JSON.stringify(review.submittedAt)} from ${review.author}`,
    );
  }
  return time;
}

function maySign(config: GateConfig, reviewer: string, login: string): boolean {
  const allowed = config.reviewers[reviewer] ?? [];
  // GitHub logins are case insensitive.
  return allowed.some((name) => name.toLowerCase() === login.toLowerCase());
}

export function evaluate(input: GateInput, config: GateConfig): GateResult {
  const headSha = input.headSha.toLowerCase();
  if (!SHA.test(headSha)) throw new Error(`head SHA must be 40 hex characters: ${input.headSha}`);
  const carried = (input.carry ?? []).map((sha) => {
    const lower = sha.toLowerCase();
    if (!SHA.test(lower)) throw new Error(`carried SHA must be 40 hex characters: ${sha}`);
    return lower;
  });
  const approvable = new Set([headSha, ...carried]);

  const ignored: IgnoredReview[] = [];
  const counted: Counted[] = [];
  for (const review of input.reviews) {
    const marker = parseMarker(review.body);
    const skip = (reason: IgnoreReason) => {
      ignored.push({
        author: review.author,
        authorType: review.authorType,
        association: review.authorAssociation ?? 'unknown',
        submittedAt: review.submittedAt,
        ...(marker === undefined ? {} : { reviewer: marker.reviewer }),
        reason,
      });
    };
    // An edit can change or remove a marker without trace, so an edited review from a
    // signer blocks every reviewer that login may sign for, whatever its body says now,
    // until the same reviewer gets a newer review with a valid marker.
    const isUser = review.authorType === 'User';
    if (review.edited === true && isUser) {
      const signable = [...KNOWN_REVIEWERS].filter((r) => maySign(config, r, review.author));
      if (signable.length > 0) {
        const time = timeOf(review);
        for (const reviewer of signable) {
          counted.push({ reviewer, verdict: 'changes_requested', review, time });
        }
        continue;
      }
    }
    if (!marker) {
      if (review.body.includes('drefyn-review')) skip('not-last-line');
      continue;
    }
    const time = timeOf(review);
    const approve = marker.verdict === 'approve';
    if (!KNOWN_REVIEWERS.has(marker.reviewer)) skip('unknown-reviewer');
    else if (!isUser) skip('not-a-user');
    else if (!maySign(config, marker.reviewer, review.author)) skip('not-allowed');
    // Only an approval is tied to a commit, the head or one it reaches through clean base
    // merges. A block on an older SHA still counts when it is the reviewer's newest
    // review: the head needs a newer approval either way.
    else if (approve && !approvable.has(marker.sha)) skip('wrong-sha');
    // Dismissing a review must not erase a block, but it does withdraw an approval.
    else if (review.dismissed === true && approve) skip('dismissed-approve');
    else {
      counted.push({
        reviewer: marker.reviewer,
        verdict: marker.verdict,
        review,
        time,
        ...(marker.sha === headSha ? {} : { sha: marker.sha }),
      });
    }
  }

  // On a timestamp tie, changes_requested sorts last so it wins: the gate fails closed.
  counted.sort(
    (a, b) =>
      a.time - b.time ||
      Number(a.verdict === 'changes_requested') - Number(b.verdict === 'changes_requested'),
  );
  const latest = new Map<string, Counted>();
  for (const item of counted) latest.set(item.reviewer, item);

  const { tier, reason: tierReason } = tierOf(input.files, config.paths);
  const required = requiredReviewers(input.labels, input.files, config.paths);
  const reviewers = required.map(({ reviewer, reason }): ReviewerResult => {
    // Nobody can sign for a reviewer with no allowed logins, so it can never pass.
    if ((config.reviewers[reviewer] ?? []).length === 0) {
      return { reviewer, state: 'no-signers', reason };
    }
    const item = latest.get(reviewer);
    if (!item) return { reviewer, state: 'missing', reason };
    const approved = item.verdict === 'approve';
    return {
      reviewer,
      state: approved ? 'approved' : 'changes_requested',
      reason,
      by: item.review.author,
      at: item.review.submittedAt,
      edited: item.review.edited === true,
      ...(item.sha === undefined ? {} : approved ? { carriedFrom: item.sha } : { sha: item.sha }),
    };
  });

  return {
    pass: reviewers.every((r) => r.state === 'approved'),
    headSha,
    tier,
    tierReason,
    carried,
    ...(input.carryNote === undefined ? {} : { carryNote: input.carryNote }),
    reviewers,
    ignored,
  };
}

function carryLines(result: GateResult): string[] {
  const note = result.carryNote ?? 'not checked';
  if (result.carried.length === 0) return [`carry-over: none (${note})`];
  return [
    'carry-over: approvals on these commits also count:',
    ...result.carried.map((sha) => `  ${sha}`),
    ...(result.carryNote === undefined ? [] : [`carry-over stopped: ${result.carryNote}`]),
  ];
}

function resultNote(r: ReviewerResult): string {
  if (r.edited === true) return ' (edited review; post a fresh one)';
  if (r.carriedFrom !== undefined) {
    return ` (on ${r.carriedFrom}, carried over clean base merges)`;
  }
  if (r.sha !== undefined) return ` (on ${r.sha})`;
  return '';
}

export function formatReport(result: GateResult): string {
  const width = Math.max(...result.reviewers.map((r) => r.reviewer.length)) + 2;
  const lines = [
    `review-gate: ${result.pass ? 'PASS' : 'FAIL'} for ${result.headSha}`,
    `risk: ${result.tierReason}`,
    ...carryLines(result),
    'required reviewers:',
    ...result.reviewers.map((r) => {
      const name = r.reviewer.padEnd(width);
      if (r.state === 'missing') return `  ${name}missing (${r.reason})`;
      if (r.state === 'no-signers') return `  ${name}no logins allowed to sign (${r.reason})`;
      const what = r.state === 'approved' ? 'approved' : 'changes requested';
      return `  ${name}${what} by ${r.by ?? '?'} at ${r.at ?? '?'}${resultNote(r)}`;
    }),
    result.ignored.length === 0 ? 'ignored markers: none' : 'ignored markers:',
    ...result.ignored.map((i) => {
      const target = i.reviewer === undefined ? '' : ` for ${i.reviewer}`;
      return `  ${i.author} (${i.authorType}, ${i.association}) at ${i.submittedAt}${target}: ${IGNORE_TEXT[i.reason]}`;
    }),
  ];
  return lines.join('\n') + '\n';
}

export function statusDescription(result: GateResult): string {
  if (result.pass) {
    const n = result.reviewers.length;
    const carried = result.reviewers.filter((r) => r.carriedFrom !== undefined).length;
    if (carried === 0) return `${n} of ${n} reviewers approved this commit`;
    return `${n} of ${n} reviewers approved; ${carried} carried over clean base merges`;
  }
  const names = (state: ReviewerState) =>
    result.reviewers.filter((r) => r.state === state).map((r) => r.reviewer);
  const parts: string[] = [];
  const blocking = names('changes_requested');
  const missing = names('missing');
  const unsigned = names('no-signers');
  if (blocking.length > 0) parts.push(`changes requested: ${blocking.join(', ')}`);
  if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`);
  if (unsigned.length > 0) parts.push(`no signers: ${unsigned.join(', ')}`);
  const text = parts.join('; ');
  return text.length <= STATUS_DESCRIPTION_LIMIT
    ? text
    : text.slice(0, STATUS_DESCRIPTION_LIMIT - 3) + '...';
}
