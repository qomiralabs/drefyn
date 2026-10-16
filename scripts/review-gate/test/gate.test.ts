import { describe, expect, it } from 'vitest';
import {
  evaluate,
  formatReport,
  parseMarker,
  requiredReviewers,
  statusDescription,
  type Entry,
  type GateConfig,
  type PathRule,
} from '../src/gate.ts';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const BASE = ['code-reviewer', 'qa-verifier', 'hygiene-auditor'];
const ALL = [...BASE, 'security-reviewer', 'performance-reviewer', 'design-reviewer'];

const marker = (reviewer: string, verdict = 'approve', sha = HEAD) =>
  `<!-- drefyn-review reviewer=${reviewer} sha=${sha} verdict=${verdict} -->`;

let clock = 0;
function entry(body: string, overrides: Partial<Entry> = {}): Entry {
  clock += 1;
  return {
    author: 'lead',
    authorAssociation: 'CONTRIBUTOR',
    createdAt: new Date(Date.UTC(2026, 9, 7, 10, 0, clock)).toISOString(),
    body,
    ...overrides,
  };
}

const approveAll = (...reviewers: string[]) =>
  reviewers.map((r) => entry(`Looks good.\n\n${marker(r)}`));

const CONFIG: GateConfig = {
  paths: [],
  reviewers: Object.fromEntries(ALL.map((r) => [r, ['lead']])),
};

const gate = (entries: Entry[], labels: string[] = [], files: string[] = [], config = CONFIG) =>
  evaluate({ headSha: HEAD, labels, files, entries }, config);

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
    expect(names(['needs-design', 'p0', 'needs-security', 'needs-perf'])).toEqual(ALL);
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

describe('evaluate: who may sign', () => {
  it('passes when every base reviewer approved the head SHA', () => {
    const result = gate(approveAll(...BASE));
    expect(result.pass).toBe(true);
    expect(result.reviewers.map((r) => r.state)).toEqual(['approved', 'approved', 'approved']);
  });

  it.each(['CONTRIBUTOR', 'NONE', 'MEMBER', 'OWNER', 'COLLABORATOR'])(
    'ignores author association %s entirely: an allowed login counts',
    (association) => {
      const entries = BASE.map((r) => entry(marker(r), { authorAssociation: association }));
      expect(gate(entries).pass).toBe(true);
    },
  );

  it.each(['MEMBER', 'OWNER'])(
    'does not count a %s whose login is not on the list for that reviewer',
    (association) => {
      const entries = [
        ...approveAll('code-reviewer', 'qa-verifier'),
        entry(marker('hygiene-auditor'), {
          author: 'someone-else',
          authorAssociation: association,
        }),
      ];
      const result = gate(entries);
      expect(result.pass).toBe(false);
      expect(result.ignored).toEqual([
        expect.objectContaining({
          author: 'someone-else',
          reviewer: 'hygiene-auditor',
          reason: 'not-allowed',
        }),
      ]);
    },
  );

  it('checks the list per reviewer name, not across all of them', () => {
    const config: GateConfig = {
      paths: [],
      reviewers: { ...CONFIG.reviewers, 'qa-verifier': ['qa-bot'] },
    };
    const result = gate(approveAll(...BASE), [], [], config);
    expect(result.pass).toBe(false);
    expect(result.ignored.map((i) => [i.reviewer, i.reason])).toEqual([
      ['qa-verifier', 'not-allowed'],
    ]);
  });

  it('matches logins without regard to case, as GitHub does', () => {
    const entries = BASE.map((r) => entry(marker(r), { author: 'LEAD' }));
    expect(gate(entries).pass).toBe(true);
  });

  it('does not let a login outside the list block with changes_requested', () => {
    const entries = [
      ...approveAll(...BASE),
      entry(marker('qa-verifier', 'changes_requested'), { author: 'drive-by' }),
    ];
    expect(gate(entries).pass).toBe(true);
  });

  it('fails closed for a required reviewer with no allowed logins', () => {
    const config: GateConfig = {
      paths: [],
      reviewers: { ...CONFIG.reviewers, 'hygiene-auditor': [] },
    };
    const result = gate(approveAll(...BASE), [], [], config);
    expect(result.pass).toBe(false);
    expect(result.reviewers.find((r) => r.reviewer === 'hygiene-auditor')?.state).toBe(
      'no-signers',
    );
  });

  it('fails closed for a required reviewer missing from the list entirely', () => {
    const rest = Object.fromEntries(
      Object.entries(CONFIG.reviewers).filter(([name]) => name !== 'security-reviewer'),
    );
    const result = gate(approveAll(...ALL), ['needs-security'], [], { paths: [], reviewers: rest });
    expect(result.pass).toBe(false);
    expect(result.reviewers.find((r) => r.reviewer === 'security-reviewer')?.state).toBe(
      'no-signers',
    );
  });

  it('does not mind an empty list for a reviewer that is not required', () => {
    const config: GateConfig = {
      paths: [],
      reviewers: { ...CONFIG.reviewers, 'design-reviewer': [] },
    };
    expect(gate(approveAll(...BASE), [], [], config).pass).toBe(true);
  });
});

describe('evaluate: which markers count', () => {
  it('fails and lists who is missing', () => {
    const result = gate(approveAll('code-reviewer'));
    expect(result.pass).toBe(false);
    expect(result.reviewers.filter((r) => r.state === 'missing').map((r) => r.reviewer)).toEqual([
      'qa-verifier',
      'hygiene-auditor',
    ]);
  });

  it('fails with no comments at all', () => {
    expect(gate([]).pass).toBe(false);
  });

  it.each([
    ['needs-security', 'security-reviewer'],
    ['needs-perf', 'performance-reviewer'],
    ['needs-design', 'design-reviewer'],
  ])('with %s, also needs %s', (label, extra) => {
    expect(gate(approveAll(...BASE), [label]).pass).toBe(false);
    expect(gate(approveAll(...BASE, extra), [label]).pass).toBe(true);
  });

  it('needs the security reviewer when paths require it', () => {
    const files = ['.github/workflows/ci.yml'];
    const config = { ...CONFIG, paths: RULES };
    expect(gate(approveAll(...BASE), [], files, config).pass).toBe(false);
    expect(gate(approveAll(...BASE, 'security-reviewer'), [], files, config).pass).toBe(true);
  });

  it('ignores markers for an older SHA and says so', () => {
    const entries = [
      ...approveAll('code-reviewer', 'qa-verifier'),
      entry(marker('hygiene-auditor', 'approve', OLD)),
    ];
    const result = gate(entries);
    expect(result.pass).toBe(false);
    expect(result.ignored.map((i) => i.reason)).toEqual(['wrong-sha']);
  });

  it('accepts the head SHA given in uppercase', () => {
    const result = evaluate(
      { headSha: HEAD.toUpperCase(), labels: [], files: [], entries: approveAll(...BASE) },
      CONFIG,
    );
    expect(result.pass).toBe(true);
  });

  it('reports a body that mentions a marker but has none on the last line', () => {
    const entries = [
      ...approveAll(...BASE),
      entry(`${marker('qa-verifier', 'changes_requested')}\nthanks`),
    ];
    const result = gate(entries);
    expect(result.pass).toBe(true);
    expect(result.ignored.map((i) => i.reason)).toEqual(['not-last-line']);
  });

  it('does not list ordinary comments as ignored', () => {
    expect(gate([...approveAll(...BASE), entry('Nice work.')]).ignored).toEqual([]);
  });

  it('ignores unknown reviewer names', () => {
    const result = gate([
      ...approveAll(...BASE),
      entry(marker('random-reviewer', 'changes_requested')),
    ]);
    expect(result.pass).toBe(true);
    expect(result.ignored.map((i) => i.reason)).toEqual(['unknown-reviewer']);
  });

  it('ignores an optional reviewer that is not required by labels', () => {
    const entries = [
      ...approveAll(...BASE),
      entry(marker('security-reviewer', 'changes_requested')),
    ];
    expect(gate(entries).pass).toBe(true);
  });

  it('records who approved, when, and why the reviewer was required', () => {
    const entries = approveAll(...BASE);
    expect(gate(entries).reviewers[0]).toEqual({
      reviewer: 'code-reviewer',
      state: 'approved',
      reason: 'always',
      by: 'lead',
      at: entries[0]?.createdAt,
      edited: false,
    });
  });
});

describe('evaluate: ordering, edits and dismissals', () => {
  it('blocks when changes_requested comes after approve for the same SHA', () => {
    const entries = [
      ...approveAll(...BASE),
      entry(`Found a bug.\n${marker('qa-verifier', 'changes_requested')}`),
    ];
    const result = gate(entries);
    expect(result.pass).toBe(false);
    expect(result.reviewers.find((r) => r.reviewer === 'qa-verifier')?.state).toBe(
      'changes_requested',
    );
  });

  it('passes when approve comes after changes_requested', () => {
    expect(
      gate([entry(marker('qa-verifier', 'changes_requested')), ...approveAll(...BASE)]).pass,
    ).toBe(true);
  });

  it('orders by created time, not by input order', () => {
    const late = entry(marker('qa-verifier', 'changes_requested'), {
      createdAt: '2030-01-01T00:00:00Z',
    });
    expect(gate([late, ...approveAll(...BASE)]).pass).toBe(false);
  });

  it('fails closed when approve and changes_requested share a timestamp', () => {
    const at = '2026-10-07T12:00:00Z';
    const entries = [
      ...approveAll('code-reviewer', 'hygiene-auditor'),
      entry(marker('qa-verifier', 'changes_requested'), { createdAt: at }),
      entry(marker('qa-verifier'), { createdAt: at }),
    ];
    expect(gate(entries).pass).toBe(false);
  });

  it('does not let a changes_requested for an old SHA block the new head', () => {
    expect(
      gate([...approveAll(...BASE), entry(marker('qa-verifier', 'changes_requested', OLD))]).pass,
    ).toBe(true);
  });

  it('keeps blocking when a later changes_requested is edited after an earlier approve', () => {
    const entries = [
      ...approveAll(...BASE),
      entry(marker('qa-verifier', 'changes_requested'), { edited: true }),
    ];
    const result = gate(entries);
    expect(result.pass).toBe(false);
    expect(result.reviewers.find((r) => r.reviewer === 'qa-verifier')).toMatchObject({
      state: 'changes_requested',
      edited: true,
    });
  });

  it('never lets an edited marker approve, even one that now says approve', () => {
    const result = gate([
      ...approveAll('code-reviewer', 'qa-verifier'),
      entry(marker('hygiene-auditor'), { edited: true }),
    ]);
    expect(result.pass).toBe(false);
    expect(result.reviewers.find((r) => r.reviewer === 'hygiene-auditor')?.state).toBe(
      'changes_requested',
    );
  });

  it('does not let a block edited into an approve bring an older approve back', () => {
    const entries = [
      ...approveAll(...BASE),
      // Was changes_requested, someone edited the body to approve.
      entry(marker('qa-verifier'), { edited: true }),
    ];
    expect(gate(entries).pass).toBe(false);
  });

  it('lets a fresh marker after an edited one decide again', () => {
    const entries = [
      ...approveAll(...BASE),
      entry(marker('qa-verifier', 'changes_requested'), { edited: true }),
      entry(marker('qa-verifier')),
    ];
    expect(gate(entries).pass).toBe(true);
  });

  it('keeps changes_requested from a dismissed review blocking', () => {
    const entries = [
      ...approveAll(...BASE),
      entry(marker('qa-verifier', 'changes_requested'), { dismissed: true }),
    ];
    const result = gate(entries);
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
    const result = gate(entries);
    expect(result.pass).toBe(false);
    expect(result.ignored.map((i) => i.reason)).toEqual(['dismissed-approve']);
  });

  it('rejects a head SHA that is not 40 hex characters', () => {
    expect(() => evaluate({ headSha: 'abc', labels: [], files: [], entries: [] }, CONFIG)).toThrow(
      /head SHA/,
    );
  });

  it('rejects an entry with an unreadable timestamp instead of guessing its order', () => {
    expect(() => gate([entry(marker('qa-verifier'), { createdAt: 'yesterday' })])).toThrow(
      /timestamp/,
    );
  });
});

describe('formatReport', () => {
  it('shows a pass with every reviewer and no ignored markers', () => {
    const report = formatReport(gate(approveAll(...BASE)));
    expect(report).toContain(`review-gate: PASS for ${HEAD}`);
    expect(report).toMatch(/code-reviewer\s+approved by lead/);
    expect(report).toContain('ignored markers: none');
  });

  it('shows what is missing, blocking or unsigned, and every ignored marker with its reason', () => {
    const entries = [
      entry(marker('code-reviewer', 'changes_requested'), {
        createdAt: '2026-10-07T10:00:00.000Z',
      }),
      entry(marker('qa-verifier', 'approve', OLD), { createdAt: '2026-10-07T10:01:00.000Z' }),
      entry(marker('hygiene-auditor'), {
        author: 'drive-by',
        authorAssociation: 'NONE',
        createdAt: '2026-10-07T10:02:00.000Z',
      }),
      entry(marker('qa-verifier'), { edited: true, createdAt: '2026-10-07T10:03:00.000Z' }),
    ];
    const config: GateConfig = {
      paths: [],
      reviewers: { ...CONFIG.reviewers, 'performance-reviewer': [] },
    };
    const report = formatReport(gate(entries, ['needs-perf'], [], config));
    expect(report).toContain('review-gate: FAIL');
    expect(report).toMatch(/code-reviewer\s+changes requested by lead/);
    expect(report).toMatch(
      /qa-verifier\s+changes requested by lead at .* \(edited marker; post a fresh one\)/,
    );
    expect(report).toMatch(/hygiene-auditor\s+missing \(always\)/);
    expect(report).toMatch(/performance-reviewer\s+no logins allowed to sign \(label needs-perf\)/);
    expect(report).toContain('ignored markers:');
    expect(report).toContain(
      '  lead (CONTRIBUTOR) at 2026-10-07T10:01:00.000Z for qa-verifier: marker for another SHA',
    );
    expect(report).toContain(
      '  drive-by (NONE) at 2026-10-07T10:02:00.000Z for hygiene-auditor: login not allowed to sign for this reviewer',
    );
  });

  it('labels an ignored entry without a reviewer name', () => {
    const report = formatReport(gate([entry(`drefyn-review sha=${HEAD}`, { author: 'x' })]));
    expect(report).toMatch(/x \(CONTRIBUTOR\) at .*: no valid marker on the last line/);
  });
});

describe('statusDescription', () => {
  it('summarises a pass', () => {
    expect(statusDescription(gate(approveAll(...BASE)))).toBe(
      '3 of 3 reviewers approved this commit',
    );
  });

  it('names blockers, missing and unsigned reviewers', () => {
    const config: GateConfig = {
      paths: [],
      reviewers: { ...CONFIG.reviewers, 'hygiene-auditor': [] },
    };
    const result = gate([entry(marker('code-reviewer', 'changes_requested'))], [], [], config);
    expect(statusDescription(result)).toBe(
      'changes requested: code-reviewer; missing: qa-verifier; no signers: hygiene-auditor',
    );
  });

  it('stays within the 140 character limit of commit statuses', () => {
    const config: GateConfig = { paths: [], reviewers: {} };
    const text = statusDescription(
      gate([], ['needs-security', 'needs-perf', 'needs-design'], [], config),
    );
    expect(text.length).toBeLessThanOrEqual(140);
    expect(text.startsWith('no signers: code-reviewer')).toBe(true);
  });
});
