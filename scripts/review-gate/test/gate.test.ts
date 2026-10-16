import { describe, expect, it } from 'vitest';
import {
  evaluate,
  formatReport,
  parseMarker,
  requiredReviewers,
  statusDescription,
  type Entry,
  type PathRule,
} from '../src/gate.ts';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

const marker = (reviewer: string, verdict = 'approve', sha = HEAD) =>
  `<!-- drefyn-review reviewer=${reviewer} sha=${sha} verdict=${verdict} -->`;

let clock = 0;
function entry(body: string, overrides: Partial<Entry> = {}): Entry {
  clock += 1;
  return {
    author: 'lead',
    authorAssociation: 'MEMBER',
    createdAt: new Date(Date.UTC(2026, 9, 7, 10, 0, clock)).toISOString(),
    body,
    ...overrides,
  };
}

const approveAll = (...reviewers: string[]) =>
  reviewers.map((r) => entry(`Looks good.\n\n${marker(r)}`));

const BASE = ['code-reviewer', 'qa-verifier', 'hygiene-auditor'];

describe('parseMarker', () => {
  it('parses a marker on the last line', () => {
    expect(parseMarker(`Review notes.\n\n${marker('code-reviewer')}`)).toEqual({
      reviewer: 'code-reviewer',
      sha: HEAD,
      verdict: 'approve',
    });
  });

  it('tolerates trailing blank lines and CRLF', () => {
    expect(parseMarker(`notes\r\n${marker('qa-verifier', 'changes_requested')}\r\n\r\n`)).toEqual({
      reviewer: 'qa-verifier',
      sha: HEAD,
      verdict: 'changes_requested',
    });
  });

  it('ignores a marker that is not on the last line', () => {
    expect(parseMarker(`${marker('code-reviewer')}\nmore text after`)).toBeUndefined();
  });

  it('ignores a marker quoted in the middle of the last line', () => {
    expect(parseMarker(`> ${marker('code-reviewer')}`)).toBeUndefined();
  });

  it.each([
    ['short sha', marker('code-reviewer', 'approve', 'a'.repeat(39))],
    ['long sha', marker('code-reviewer', 'approve', 'a'.repeat(41))],
    ['uppercase sha', marker('code-reviewer', 'approve', 'A'.repeat(40))],
    ['non hex sha', marker('code-reviewer', 'approve', 'g'.repeat(40))],
    ['unknown verdict', marker('code-reviewer', 'lgtm')],
    ['uppercase verdict', marker('code-reviewer', 'APPROVE')],
    ['missing field', `<!-- drefyn-review reviewer=code-reviewer sha=${HEAD} -->`],
    ['wrong prefix', `<!-- review reviewer=code-reviewer sha=${HEAD} verdict=approve -->`],
    ['extra field', `<!-- drefyn-review reviewer=x sha=${HEAD} verdict=approve by=me -->`],
    ['empty body', ''],
  ])('rejects %s', (_name, body) => {
    expect(parseMarker(body)).toBeUndefined();
  });
});

const RULES: PathRule[] = [
  {
    reviewer: 'security-reviewer',
    prefixes: ['.github/', 'scripts/'],
    names: ['package.json', 'pnpm-lock.yaml'],
    contains: ['auth', 'billing'],
  },
];

const names = (labels: string[], files: string[] = [], rules: PathRule[] = []) =>
  requiredReviewers(labels, files, rules).map((r) => r.reviewer);

describe('requiredReviewers', () => {
  it('always needs the three base reviewers', () => {
    expect(names([])).toEqual(BASE);
    expect(requiredReviewers([], [], [])[0]).toEqual({
      reviewer: 'code-reviewer',
      reason: 'always',
    });
  });

  it('adds reviewers for each needs label, in a stable order', () => {
    expect(names(['needs-design', 'p0', 'needs-security', 'needs-perf'])).toEqual([
      ...BASE,
      'security-reviewer',
      'performance-reviewer',
      'design-reviewer',
    ]);
  });

  it('matches labels without regard to case, as GitHub does', () => {
    expect(names(['Needs-Security', 'NEEDS-PERF'])).toEqual([
      ...BASE,
      'security-reviewer',
      'performance-reviewer',
    ]);
  });

  it('does not match a label that only starts with a needs label', () => {
    expect(names(['needs-security-later'])).toEqual(BASE);
  });

  it.each([
    ['.github/workflows/ci.yml', 'path .github/workflows/ci.yml'],
    ['scripts/review-gate/src/gate.ts', 'path scripts/review-gate/src/gate.ts'],
    ['package.json', 'path package.json'],
    ['packages/core/package.json', 'path packages/core/package.json'],
    ['packages/oauth/src/login.ts', 'path packages/oauth/src/login.ts'],
    ['apps/web/src/Billing/plans.ts', 'path apps/web/src/Billing/plans.ts'],
    ['.GITHUB/x.yml', 'path .GITHUB/x.yml'],
  ])('adds the security reviewer for %s', (file, reason) => {
    const required = requiredReviewers([], ['README.md', file], RULES);
    expect(required.at(-1)).toEqual({ reviewer: 'security-reviewer', reason });
  });

  it.each(['README.md', 'docs/guide.md', 'apps/web/src/page.tsx', 'my-scripts/x.ts'])(
    'does not add the security reviewer for %s',
    (file) => {
      expect(names([], [file], RULES)).toEqual(BASE);
    },
  );

  it('prefers the label as the reason and lists a reviewer once', () => {
    const required = requiredReviewers(['needs-security'], ['.github/x.yml'], RULES);
    expect(required.filter((r) => r.reviewer === 'security-reviewer')).toEqual([
      { reviewer: 'security-reviewer', reason: 'label needs-security' },
    ]);
  });

  it('cannot be avoided by removing the label when paths still need it', () => {
    expect(names([], ['scripts/gate.sh'], RULES)).toContain('security-reviewer');
  });
});

describe('evaluate', () => {
  it('passes when every base reviewer approved the head SHA', () => {
    const result = evaluate({ headSha: HEAD, files: [], labels: [], entries: approveAll(...BASE) });
    expect(result.pass).toBe(true);
    expect(result.reviewers.map((r) => r.state)).toEqual(['approved', 'approved', 'approved']);
  });

  it('fails and lists who is missing', () => {
    const result = evaluate({
      headSha: HEAD,
      files: [],
      labels: [],
      entries: approveAll('code-reviewer'),
    });
    expect(result.pass).toBe(false);
    expect(result.reviewers.filter((r) => r.state === 'missing').map((r) => r.reviewer)).toEqual([
      'qa-verifier',
      'hygiene-auditor',
    ]);
  });

  it('fails with no comments at all', () => {
    expect(evaluate({ headSha: HEAD, files: [], labels: [], entries: [] }).pass).toBe(false);
  });

  it.each([
    ['needs-security', 'security-reviewer'],
    ['needs-perf', 'performance-reviewer'],
    ['needs-design', 'design-reviewer'],
  ])('with %s, also needs %s', (label, extra) => {
    const without = evaluate({
      headSha: HEAD,
      files: [],
      labels: [label],
      entries: approveAll(...BASE),
    });
    expect(without.pass).toBe(false);
    const withIt = evaluate({
      headSha: HEAD,
      files: [],
      labels: [label],
      entries: approveAll(...BASE, extra),
    });
    expect(withIt.pass).toBe(true);
  });

  it('ignores markers for an older SHA', () => {
    const entries = [
      ...approveAll('code-reviewer', 'qa-verifier'),
      entry(marker('hygiene-auditor', 'approve', OLD)),
    ];
    const result = evaluate({ headSha: HEAD, files: [], labels: [], entries });
    expect(result.pass).toBe(false);
    expect(result.ignored.otherSha).toBe(1);
  });

  it('accepts the head SHA given in uppercase', () => {
    const result = evaluate({
      headSha: HEAD.toUpperCase(),
      files: [],
      labels: [],
      entries: approveAll(...BASE),
    });
    expect(result.pass).toBe(true);
  });

  it.each(['NONE', 'CONTRIBUTOR', 'COLLABORATOR', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR', ''])(
    'ignores markers from association %j',
    (association) => {
      const entries = [
        ...approveAll('code-reviewer', 'qa-verifier'),
        entry(marker('hygiene-auditor'), { author: 'drive-by', authorAssociation: association }),
      ];
      const result = evaluate({ headSha: HEAD, files: [], labels: [], entries });
      expect(result.pass).toBe(false);
      expect(result.ignored.notMember).toBe(1);
    },
  );

  it('accepts OWNER as well as MEMBER', () => {
    const entries = [
      ...approveAll('code-reviewer', 'qa-verifier'),
      entry(marker('hygiene-auditor'), { authorAssociation: 'OWNER' }),
    ];
    expect(evaluate({ headSha: HEAD, files: [], labels: [], entries }).pass).toBe(true);
  });

  it('blocks when changes_requested comes after approve for the same SHA', () => {
    const entries = [
      ...approveAll(...BASE),
      entry(`Found a bug.\n${marker('qa-verifier', 'changes_requested')}`),
    ];
    const result = evaluate({ headSha: HEAD, files: [], labels: [], entries });
    expect(result.pass).toBe(false);
    expect(result.reviewers.find((r) => r.reviewer === 'qa-verifier')?.state).toBe(
      'changes_requested',
    );
  });

  it('passes when approve comes after changes_requested', () => {
    const entries = [entry(marker('qa-verifier', 'changes_requested')), ...approveAll(...BASE)];
    expect(evaluate({ headSha: HEAD, files: [], labels: [], entries }).pass).toBe(true);
  });

  it('orders by created time, not by input order', () => {
    const late = entry(marker('qa-verifier', 'changes_requested'), {
      createdAt: '2030-01-01T00:00:00Z',
    });
    const entries = [late, ...approveAll(...BASE)];
    expect(evaluate({ headSha: HEAD, files: [], labels: [], entries }).pass).toBe(false);
  });

  it('fails closed when approve and changes_requested share a timestamp', () => {
    const at = '2026-10-07T12:00:00Z';
    const entries = [
      ...approveAll('code-reviewer', 'hygiene-auditor'),
      entry(marker('qa-verifier', 'changes_requested'), { createdAt: at }),
      entry(marker('qa-verifier'), { createdAt: at }),
    ];
    expect(evaluate({ headSha: HEAD, files: [], labels: [], entries }).pass).toBe(false);
  });

  it('does not let a changes_requested for an old SHA block the new head', () => {
    const entries = [
      ...approveAll(...BASE),
      entry(marker('qa-verifier', 'changes_requested', OLD)),
    ];
    expect(evaluate({ headSha: HEAD, files: [], labels: [], entries }).pass).toBe(true);
  });

  it('does not let a non member block with changes_requested', () => {
    const entries = [
      ...approveAll(...BASE),
      entry(marker('qa-verifier', 'changes_requested'), { authorAssociation: 'NONE' }),
    ];
    expect(evaluate({ headSha: HEAD, files: [], labels: [], entries }).pass).toBe(true);
  });

  it('ignores unknown reviewer names', () => {
    const entries = [...approveAll(...BASE), entry(marker('random-reviewer', 'changes_requested'))];
    const result = evaluate({ headSha: HEAD, files: [], labels: [], entries });
    expect(result.pass).toBe(true);
    expect(result.ignored.unknownReviewer).toBe(1);
  });

  it('ignores an optional reviewer that is not required by labels', () => {
    const entries = [
      ...approveAll(...BASE),
      entry(marker('security-reviewer', 'changes_requested')),
    ];
    expect(evaluate({ headSha: HEAD, files: [], labels: [], entries }).pass).toBe(true);
  });

  it('ignores a marker on an edited comment or review', () => {
    const entries = [
      ...approveAll('code-reviewer', 'qa-verifier'),
      entry(marker('hygiene-auditor'), { edited: true }),
    ];
    const result = evaluate({ headSha: HEAD, files: [], labels: [], entries });
    expect(result.pass).toBe(false);
    expect(result.ignored.edited).toBe(1);
  });

  it('does not let an edit turn a block into an approval', () => {
    const entries = [
      ...approveAll(...BASE),
      entry(marker('qa-verifier', 'changes_requested')),
      entry(marker('qa-verifier'), { edited: true }),
    ];
    expect(evaluate({ headSha: HEAD, files: [], labels: [], entries }).pass).toBe(false);
  });

  it('keeps changes_requested from a dismissed review blocking', () => {
    const entries = [
      ...approveAll(...BASE),
      entry(marker('qa-verifier', 'changes_requested'), { dismissed: true }),
    ];
    const result = evaluate({ headSha: HEAD, files: [], labels: [], entries });
    expect(result.pass).toBe(false);
    expect(result.reviewers.find((r) => r.reviewer === 'qa-verifier')?.state).toBe(
      'changes_requested',
    );
  });

  it('does not count an approval from a dismissed review', () => {
    const entries = [
      ...approveAll('code-reviewer', 'qa-verifier'),
      entry(marker('hygiene-auditor'), { dismissed: true }),
    ];
    const result = evaluate({ headSha: HEAD, files: [], labels: [], entries });
    expect(result.pass).toBe(false);
    expect(result.ignored.dismissedApproval).toBe(1);
  });

  it('needs the security reviewer when paths require it', () => {
    const input = { headSha: HEAD, files: ['.github/workflows/ci.yml'], labels: [] };
    expect(evaluate({ ...input, entries: approveAll(...BASE) }, RULES).pass).toBe(false);
    expect(
      evaluate({ ...input, entries: approveAll(...BASE, 'security-reviewer') }, RULES).pass,
    ).toBe(true);
  });

  it('records who approved and when', () => {
    const entries = approveAll(...BASE);
    const result = evaluate({ headSha: HEAD, files: [], labels: [], entries });
    expect(result.reviewers[0]).toEqual({
      reviewer: 'code-reviewer',
      state: 'approved',
      reason: 'always',
      by: 'lead',
      at: entries[0]?.createdAt,
    });
  });

  it('rejects a head SHA that is not 40 hex characters', () => {
    expect(() => evaluate({ headSha: 'abc', files: [], labels: [], entries: [] })).toThrow(
      /head SHA/,
    );
  });

  it('rejects an entry with an unreadable timestamp instead of guessing its order', () => {
    const entries = [entry(marker('qa-verifier'), { createdAt: 'yesterday' })];
    expect(() => evaluate({ headSha: HEAD, files: [], labels: [], entries })).toThrow(/timestamp/);
  });
});

describe('formatReport', () => {
  it('shows a pass with every reviewer', () => {
    const report = formatReport(
      evaluate({ headSha: HEAD, files: [], labels: [], entries: approveAll(...BASE) }),
    );
    expect(report).toContain(`review-gate: PASS for ${HEAD}`);
    expect(report).toMatch(/code-reviewer\s+approved by lead/);
  });

  it('shows what is missing or blocking and what was ignored', () => {
    const entries = [
      entry(marker('code-reviewer', 'changes_requested')),
      entry(marker('qa-verifier', 'approve', OLD)),
      entry(marker('hygiene-auditor'), { authorAssociation: 'NONE' }),
    ];
    const report = formatReport(
      evaluate({ headSha: HEAD, files: [], labels: ['needs-perf'], entries }),
    );
    expect(report).toContain('review-gate: FAIL');
    expect(report).toMatch(/code-reviewer\s+changes requested by lead/);
    expect(report).toMatch(/qa-verifier\s+missing/);
    expect(report).toMatch(/performance-reviewer\s+missing \(label needs-perf\)/);
    expect(report).toContain(
      'ignored: 1 for another SHA, 1 from non members, 0 unknown reviewers, 0 edited, 0 approvals on dismissed reviews',
    );
  });
});

describe('statusDescription', () => {
  it('summarises a pass', () => {
    const result = evaluate({ headSha: HEAD, files: [], labels: [], entries: approveAll(...BASE) });
    expect(statusDescription(result)).toBe('3 of 3 reviewers approved this commit');
  });

  it('names blockers and missing reviewers', () => {
    const entries = [entry(marker('code-reviewer', 'changes_requested'))];
    const result = evaluate({ headSha: HEAD, files: [], labels: [], entries });
    expect(statusDescription(result)).toBe(
      'changes requested: code-reviewer; missing: qa-verifier, hygiene-auditor',
    );
  });

  it('stays within the 140 character limit of commit statuses', () => {
    const result = evaluate({
      headSha: HEAD,
      files: [],
      labels: ['needs-security', 'needs-perf', 'needs-design'],
      entries: [],
    });
    const text = statusDescription(result);
    expect(text.length).toBeLessThanOrEqual(140);
    expect(text.startsWith('missing: code-reviewer')).toBe(true);
  });
});
