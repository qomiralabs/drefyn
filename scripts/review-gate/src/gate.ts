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
  // Kept for the report only. The Actions token cannot see private org membership, so
  // this says CONTRIBUTOR for members and is no signal of trust.
  authorAssociation?: string;
  submittedAt: string;
  body: string;
  // Anyone with write access can edit someone else's comment, and the author stays the
  // same, so an edited body is not evidence of what its author decided.
  edited?: boolean;
  dismissed?: boolean;
}

export interface GateInput {
  headSha: string;
  labels: string[];
  files: string[];
  reviews: Review[];
}

// Paths that require a reviewer whatever the labels say, since labels can be removed.
export interface PathRule {
  reviewer: string;
  prefixes: string[];
  names: string[];
  contains: string[];
}

// Which logins may sign for each reviewer name, plus the path rules.
export interface GateConfig {
  paths: PathRule[];
  reviewers: Record<string, string[]>;
}

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
}

export type IgnoreReason =
  'not-last-line' | 'unknown-reviewer' | 'not-allowed' | 'wrong-sha' | 'dismissed-approve';

export interface IgnoredEntry {
  author: string;
  association: string;
  submittedAt: string;
  reviewer?: string;
  reason: IgnoreReason;
}

export interface GateResult {
  pass: boolean;
  headSha: string;
  reviewers: ReviewerResult[];
  ignored: IgnoredEntry[];
}

const IGNORE_TEXT: Record<IgnoreReason, string> = {
  'not-last-line': 'no valid marker on the last line',
  'unknown-reviewer': 'unknown reviewer name',
  'not-allowed': 'login not allowed to sign for this reviewer',
  'wrong-sha': 'marker for another SHA',
  'dismissed-approve': 'approval on a dismissed review',
};

const BASE_REVIEWERS = ['code-reviewer', 'qa-verifier', 'hygiene-auditor'];
const LABELLED_REVIEWERS: readonly (readonly [label: string, reviewer: string])[] = [
  ['needs-security', 'security-reviewer'],
  ['needs-perf', 'performance-reviewer'],
  ['needs-design', 'design-reviewer'],
];
export const KNOWN_REVIEWERS = new Set([
  ...BASE_REVIEWERS,
  ...LABELLED_REVIEWERS.map(([, r]) => r),
]);

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

function ruleMatches(rule: PathRule, path: string): boolean {
  const lower = path.toLowerCase();
  const name = lower.split('/').at(-1) ?? '';
  return (
    rule.prefixes.some((prefix) => lower.startsWith(prefix.toLowerCase())) ||
    rule.names.some((n) => n.toLowerCase() === name) ||
    rule.contains.some((part) => lower.includes(part.toLowerCase()))
  );
}

export function requiredReviewers(
  labels: string[],
  files: string[],
  rules: PathRule[],
): Requirement[] {
  // GitHub treats label names case insensitively, so the gate does too.
  const set = new Set(labels.map((label) => label.toLowerCase()));
  const required = new Map<string, string>(BASE_REVIEWERS.map((r) => [r, 'always']));
  for (const [label, reviewer] of LABELLED_REVIEWERS) {
    if (set.has(label)) required.set(reviewer, `label ${label}`);
  }
  for (const rule of rules) {
    if (required.has(rule.reviewer)) continue;
    const hit = files.find((file) => ruleMatches(rule, file));
    if (hit !== undefined) required.set(rule.reviewer, `path ${hit}`);
  }
  const order = [...BASE_REVIEWERS, ...LABELLED_REVIEWERS.map(([, r]) => r)];
  return order.flatMap((reviewer) => {
    const reason = required.get(reviewer);
    return reason === undefined ? [] : [{ reviewer, reason }];
  });
}

interface Counted {
  reviewer: string;
  verdict: Verdict;
  review: Review;
  time: number;
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

  const ignored: IgnoredEntry[] = [];
  const counted: Counted[] = [];
  for (const review of input.reviews) {
    const marker = parseMarker(review.body);
    const skip = (reason: IgnoreReason) => {
      ignored.push({
        author: review.author,
        association: review.authorAssociation ?? 'unknown',
        submittedAt: review.submittedAt,
        ...(marker === undefined ? {} : { reviewer: marker.reviewer }),
        reason,
      });
    };
    // An edit can change or remove a marker without trace, so an edited review from a
    // signer blocks every reviewer that login may sign for, whatever its body says now,
    // until the same reviewer gets a newer review with a valid marker.
    if (review.edited === true) {
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
    if (!KNOWN_REVIEWERS.has(marker.reviewer)) skip('unknown-reviewer');
    else if (!maySign(config, marker.reviewer, review.author)) skip('not-allowed');
    else if (marker.sha !== headSha) skip('wrong-sha');
    // Dismissing a review must not erase a block, but it does withdraw an approval.
    else if (review.dismissed === true && marker.verdict === 'approve') skip('dismissed-approve');
    else counted.push({ reviewer: marker.reviewer, verdict: marker.verdict, review, time });
  }

  // On a timestamp tie, changes_requested sorts last so it wins: the gate fails closed.
  counted.sort(
    (a, b) =>
      a.time - b.time ||
      Number(a.verdict === 'changes_requested') - Number(b.verdict === 'changes_requested'),
  );
  const latest = new Map<string, Counted>();
  for (const item of counted) latest.set(item.reviewer, item);

  const required = requiredReviewers(input.labels, input.files, config.paths);
  const reviewers = required.map(({ reviewer, reason }): ReviewerResult => {
    // Nobody can sign for a reviewer with no allowed logins, so it can never pass.
    if ((config.reviewers[reviewer] ?? []).length === 0) {
      return { reviewer, state: 'no-signers', reason };
    }
    const item = latest.get(reviewer);
    if (!item) return { reviewer, state: 'missing', reason };
    return {
      reviewer,
      state: item.verdict === 'approve' ? 'approved' : 'changes_requested',
      reason,
      by: item.review.author,
      at: item.review.submittedAt,
      edited: item.review.edited === true,
    };
  });

  return {
    pass: reviewers.every((r) => r.state === 'approved'),
    headSha,
    reviewers,
    ignored,
  };
}

export function formatReport(result: GateResult): string {
  const width = Math.max(...result.reviewers.map((r) => r.reviewer.length)) + 2;
  const lines = [
    `review-gate: ${result.pass ? 'PASS' : 'FAIL'} for ${result.headSha}`,
    'required reviewers:',
    ...result.reviewers.map((r) => {
      const name = r.reviewer.padEnd(width);
      if (r.state === 'missing') return `  ${name}missing (${r.reason})`;
      if (r.state === 'no-signers') return `  ${name}no logins allowed to sign (${r.reason})`;
      const what = r.state === 'approved' ? 'approved' : 'changes requested';
      const note = r.edited === true ? ' (edited review; post a fresh one)' : '';
      return `  ${name}${what} by ${r.by ?? '?'} at ${r.at ?? '?'}${note}`;
    }),
    result.ignored.length === 0 ? 'ignored markers: none' : 'ignored markers:',
    ...result.ignored.map((i) => {
      const target = i.reviewer === undefined ? '' : ` for ${i.reviewer}`;
      return `  ${i.author} (${i.association}) at ${i.submittedAt}${target}: ${IGNORE_TEXT[i.reason]}`;
    }),
  ];
  return lines.join('\n') + '\n';
}

export function statusDescription(result: GateResult): string {
  if (result.pass) {
    const n = result.reviewers.length;
    return `${n} of ${n} reviewers approved this commit`;
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
