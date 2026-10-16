export type Verdict = 'approve' | 'changes_requested';

export interface Marker {
  reviewer: string;
  sha: string;
  verdict: Verdict;
}

// One PR issue comment or submitted review body.
export interface Entry {
  author: string;
  authorAssociation: string;
  createdAt: string;
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
  entries: Entry[];
}

// Paths that require a reviewer whatever the labels say, since labels can be removed.
export interface PathRule {
  reviewer: string;
  prefixes: string[];
  names: string[];
  contains: string[];
}

export interface Requirement {
  reviewer: string;
  reason: string;
}

export type ReviewerState = 'approved' | 'changes_requested' | 'missing';

export interface ReviewerResult {
  reviewer: string;
  state: ReviewerState;
  reason: string;
  by?: string;
  at?: string;
}

export interface GateResult {
  pass: boolean;
  headSha: string;
  reviewers: ReviewerResult[];
  ignored: {
    otherSha: number;
    notMember: number;
    unknownReviewer: number;
    edited: number;
    dismissedApproval: number;
  };
}

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

// Collaborators can be outside contributors with write access; only the org decides.
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER']);

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
  marker: Marker;
  entry: Entry;
  time: number;
}

function timeOf(entry: Entry): number {
  const time = Date.parse(entry.createdAt);
  if (Number.isNaN(time)) {
    throw new Error(`unreadable timestamp ${JSON.stringify(entry.createdAt)} from ${entry.author}`);
  }
  return time;
}

export function evaluate(input: GateInput, rules: PathRule[] = []): GateResult {
  const headSha = input.headSha.toLowerCase();
  if (!SHA.test(headSha)) throw new Error(`head SHA must be 40 hex characters: ${input.headSha}`);

  const ignored = {
    otherSha: 0,
    notMember: 0,
    unknownReviewer: 0,
    edited: 0,
    dismissedApproval: 0,
  };
  const counted: Counted[] = [];
  for (const entry of input.entries) {
    const marker = parseMarker(entry.body);
    if (!marker) continue;
    const time = timeOf(entry);
    if (!TRUSTED_ASSOCIATIONS.has(entry.authorAssociation)) ignored.notMember += 1;
    else if (marker.sha !== headSha) ignored.otherSha += 1;
    else if (!KNOWN_REVIEWERS.has(marker.reviewer)) ignored.unknownReviewer += 1;
    else if (entry.edited === true) ignored.edited += 1;
    // Dismissing a review must not erase a block, but it does withdraw an approval.
    else if (entry.dismissed === true && marker.verdict === 'approve')
      ignored.dismissedApproval += 1;
    else counted.push({ marker, entry, time });
  }

  // On a timestamp tie, changes_requested sorts last so it wins: the gate fails closed.
  counted.sort(
    (a, b) =>
      a.time - b.time ||
      Number(a.marker.verdict === 'changes_requested') -
        Number(b.marker.verdict === 'changes_requested'),
  );
  const latest = new Map<string, Counted>();
  for (const item of counted) latest.set(item.marker.reviewer, item);

  const required = requiredReviewers(input.labels, input.files, rules);
  const reviewers = required.map(({ reviewer, reason }): ReviewerResult => {
    const item = latest.get(reviewer);
    if (!item) return { reviewer, state: 'missing', reason };
    return {
      reviewer,
      state: item.marker.verdict === 'approve' ? 'approved' : 'changes_requested',
      reason,
      by: item.entry.author,
      at: item.entry.createdAt,
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
      const what = r.state === 'approved' ? 'approved' : 'changes requested';
      return `  ${name}${what} by ${r.by ?? '?'} at ${r.at ?? '?'}`;
    }),
    `ignored: ${result.ignored.otherSha} for another SHA, ${result.ignored.notMember} from non members, ${result.ignored.unknownReviewer} unknown reviewers, ${result.ignored.edited} edited, ${result.ignored.dismissedApproval} approvals on dismissed reviews`,
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
  if (blocking.length > 0) parts.push(`changes requested: ${blocking.join(', ')}`);
  if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`);
  const text = parts.join('; ');
  return text.length <= STATUS_DESCRIPTION_LIMIT
    ? text
    : text.slice(0, STATUS_DESCRIPTION_LIMIT - 3) + '...';
}
