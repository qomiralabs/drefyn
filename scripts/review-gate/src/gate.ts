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
}

export interface GateInput {
  headSha: string;
  labels: string[];
  entries: Entry[];
}

export type ReviewerState = 'approved' | 'changes_requested' | 'missing';

export interface ReviewerResult {
  reviewer: string;
  state: ReviewerState;
  by?: string;
  at?: string;
}

export interface GateResult {
  pass: boolean;
  headSha: string;
  reviewers: ReviewerResult[];
  ignored: { otherSha: number; notMember: number; unknownReviewer: number };
}

const BASE_REVIEWERS = ['code-reviewer', 'qa-verifier', 'hygiene-auditor'];
const LABELLED_REVIEWERS: readonly (readonly [label: string, reviewer: string])[] = [
  ['needs-security', 'security-reviewer'],
  ['needs-perf', 'performance-reviewer'],
  ['needs-design', 'design-reviewer'],
];
const KNOWN_REVIEWERS = new Set([...BASE_REVIEWERS, ...LABELLED_REVIEWERS.map(([, r]) => r)]);

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

export function requiredReviewers(labels: string[]): string[] {
  const set = new Set(labels);
  return [
    ...BASE_REVIEWERS,
    ...LABELLED_REVIEWERS.filter(([label]) => set.has(label)).map(([, reviewer]) => reviewer),
  ];
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

export function evaluate(input: GateInput): GateResult {
  const headSha = input.headSha.toLowerCase();
  if (!SHA.test(headSha)) throw new Error(`head SHA must be 40 hex characters: ${input.headSha}`);

  const ignored = { otherSha: 0, notMember: 0, unknownReviewer: 0 };
  const counted: Counted[] = [];
  for (const entry of input.entries) {
    const marker = parseMarker(entry.body);
    if (!marker) continue;
    const time = timeOf(entry);
    if (!TRUSTED_ASSOCIATIONS.has(entry.authorAssociation)) ignored.notMember += 1;
    else if (marker.sha !== headSha) ignored.otherSha += 1;
    else if (!KNOWN_REVIEWERS.has(marker.reviewer)) ignored.unknownReviewer += 1;
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

  const reviewers = requiredReviewers(input.labels).map((reviewer): ReviewerResult => {
    const item = latest.get(reviewer);
    if (!item) return { reviewer, state: 'missing' };
    return {
      reviewer,
      state: item.marker.verdict === 'approve' ? 'approved' : 'changes_requested',
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
      if (r.state === 'missing') return `  ${name}missing`;
      const what = r.state === 'approved' ? 'approved' : 'changes requested';
      return `  ${name}${what} by ${r.by ?? '?'} at ${r.at ?? '?'}`;
    }),
    `ignored: ${result.ignored.otherSha} for another SHA, ${result.ignored.notMember} from non members, ${result.ignored.unknownReviewer} unknown reviewers`,
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
