import { describe, expect, it } from 'vitest';
import {
  classify,
  evaluate,
  formatReport,
  parseMarker,
  requiredReviewers,
  statusDescription,
  tierOf,
  type GateConfig,
  type Matcher,
  type PathRules,
  type Review,
} from '../src/gate.ts';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const MERGED = 'c'.repeat(40);
// Tier B product code needs these two.
const BASE = ['code-reviewer', 'qa-verifier'];
const TIER_A = ['code-reviewer', 'qa-verifier', 'security-reviewer'];
const ALL = [...TIER_A, 'performance-reviewer', 'design-reviewer'];

const marker = (reviewer: string, verdict = 'approve', sha = HEAD) =>
  `<!-- drefyn-review reviewer=${reviewer} sha=${sha} verdict=${verdict} -->`;

let clock = 0;
function review(body: string, overrides: Partial<Review> = {}): Review {
  clock += 1;
  return {
    author: 'lead',
    authorType: 'User',
    authorAssociation: 'CONTRIBUTOR',
    submittedAt: new Date(Date.UTC(2026, 9, 7, 10, 0, clock)).toISOString(),
    body,
    ...overrides,
  };
}

const approveAll = (...reviewers: string[]) =>
  reviewers.map((r) => review(`Looks good.\n\n${marker(r)}`));

const m = (part: Partial<Matcher>): Matcher => ({
  prefixes: [],
  names: [],
  contains: [],
  suffixes: [],
  ...part,
});

const PATHS: PathRules = {
  security: m({ prefixes: ['.github/', 'scripts/'], names: ['package.json'], contains: ['auth'] }),
  tests: m({
    prefixes: ['test/', 'packages/*/test/', 'apps/*/__tests__/'],
    suffixes: ['.test.ts', '.test.tsx'],
  }),
  ui: m({ prefixes: ['apps/', 'packages/ui/'], suffixes: ['.tsx', '.css'] }),
  docs: m({ suffixes: ['.md'] }),
};

const CONFIG: GateConfig = {
  paths: PATHS,
  reviewers: Object.fromEntries(ALL.map((r) => [r, ['lead']])),
};

const PRODUCT = ['packages/core/src/index.ts'];

const gate = (
  reviews: Review[],
  labels: string[] = [],
  files: string[] = PRODUCT,
  config = CONFIG,
  carry?: string[],
) =>
  evaluate(
    { headSha: HEAD, labels, files, reviews, ...(carry === undefined ? {} : { carry }) },
    config,
  );

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

describe('classify', () => {
  it.each([
    ['.github/workflows/ci.yml', 'A', false],
    ['.github/pull_request_template.md', 'A', false],
    ['scripts/review-gate/test/gate.test.ts', 'A', false],
    ['packages/auth/test/session.test.ts', 'A', false],
    ['apps/web/src/auth/Login.tsx', 'A', true],
    ['packages/core/package.json', 'A', false],
    ['.GITHUB/x.yml', 'A', false],
    ['packages/core/src/index.ts', 'B', false],
    ['vitest.config.ts', 'B', false],
    ['apps/web/src/page.ts', 'B', true],
    ['packages/ui/src/tokens.ts', 'B', true],
    ['packages/core/src/badge.tsx', 'B', true],
    ['apps/website/content/pricing.md', 'B', true],
    ['packages/core/test/index.test.ts', 'C', false],
    ['packages/core/src/index.test.ts', 'C', false],
    ['packages/ui/src/Button.test.tsx', 'C', false],
    ['apps/web/__tests__/page.tsx', 'C', false],
    ['test/fixtures/data.json', 'C', false],
    ['README.md', 'C', false],
    ['docs/guide.txt', 'B', false],
    ['apps/web/app/test/page.tsx', 'B', true],
    ['packages/monitors/src/tests/http.ts', 'B', false],
    ['packages/core/README.MD', 'C', false],
  ])('puts %s in tier %s (ui %s)', (file, tier, ui) => {
    expect(classify(file, PATHS)).toEqual({ tier, ui });
  });

  it('lets a wildcard in a prefix stand for exactly one path segment', () => {
    expect(classify('packages/core/test/x.ts', PATHS).tier).toBe('C');
    expect(classify('packages/core/src/test/x.ts', PATHS).tier).toBe('B');
    expect(classify('packages/a/b/test/x.ts', PATHS).tier).toBe('B');
    expect(classify('packages/test/x.ts', PATHS).tier).toBe('B');
    expect(classify('packages/core/testing/x.ts', PATHS).tier).toBe('B');
    expect(classify('packages//test/x.ts', PATHS).tier).toBe('B');
  });

  it('treats regex characters in a prefix literally', () => {
    const paths = { ...PATHS, tests: m({ prefixes: ['a.b/*/t+/'] }) };
    expect(classify('a.b/x/t+/y.ts', paths).tier).toBe('C');
    expect(classify('aXb/x/tt/y.ts', paths).tier).toBe('B');
  });
});

describe('tierOf', () => {
  it('takes the highest tier of any file and names it', () => {
    expect(tierOf(['README.md', 'packages/core/src/a.ts'], PATHS)).toEqual({
      tier: 'B',
      reason: 'tier B, path packages/core/src/a.ts',
    });
    expect(tierOf(['README.md', 'src/a.ts', '.github/x.yml', 'scripts/y.sh'], PATHS)).toEqual({
      tier: 'A',
      reason: 'tier A, path .github/x.yml',
    });
  });

  it('is tier C only when every file is a test or a doc', () => {
    expect(tierOf(['README.md', 'packages/core/test/a.test.ts'], PATHS)).toEqual({
      tier: 'C',
      reason: 'tier C, tests and docs only',
    });
  });

  it('fails closed to tier A when there are no changed files', () => {
    expect(tierOf([], PATHS)).toEqual({ tier: 'A', reason: 'tier A, no changed files' });
  });
});

const names = (labels: string[], files: string[] = PRODUCT, paths: PathRules = PATHS) =>
  requiredReviewers(labels, files, paths).map((r) => r.reviewer);

describe('requiredReviewers', () => {
  it('needs code-reviewer and qa-verifier for tier B', () => {
    expect(names([])).toEqual(BASE);
    expect(requiredReviewers([], PRODUCT, PATHS)[0]).toEqual({
      reviewer: 'code-reviewer',
      reason: 'tier B, path packages/core/src/index.ts',
    });
  });

  it('needs code-reviewer, qa-verifier and security-reviewer for tier A', () => {
    expect(names([], ['README.md', 'scripts/gate.sh'])).toEqual(TIER_A);
    expect(requiredReviewers([], ['scripts/gate.sh'], PATHS).at(-1)).toEqual({
      reviewer: 'security-reviewer',
      reason: 'tier A, path scripts/gate.sh',
    });
  });

  it('needs only code-reviewer for tier C', () => {
    expect(names([], ['README.md', 'docs/a.md', 'packages/x/test/a.test.ts'])).toEqual([
      'code-reviewer',
    ]);
  });

  it('needs every tier A reviewer for an empty file list', () => {
    expect(names([], [])).toEqual(TIER_A);
  });

  it('adds design-reviewer when a UI path changes, in any tier but C', () => {
    expect(names([], ['apps/web/src/page.ts'])).toEqual([...BASE, 'design-reviewer']);
    expect(names([], ['apps/web/src/auth/Login.tsx'])).toEqual([...TIER_A, 'design-reviewer']);
    expect(requiredReviewers([], ['src/a.ts', 'packages/ui/x.ts'], PATHS).at(-1)).toEqual({
      reviewer: 'design-reviewer',
      reason: 'ui path packages/ui/x.ts',
    });
  });

  it('does not add design-reviewer for a UI test', () => {
    expect(names([], ['packages/ui/src/Button.test.tsx'])).toEqual(['code-reviewer']);
  });

  it('never needs hygiene-auditor, which the CI hygiene job replaces', () => {
    expect(names(['needs-hygiene'], ['scripts/hygiene/src/cli.ts'])).not.toContain(
      'hygiene-auditor',
    );
  });

  it('adds reviewers for each needs label, in a stable order', () => {
    expect(names(['needs-design', 'p0', 'needs-security', 'needs-perf'])).toEqual(ALL);
  });

  it('lets a label add reviewers on top of tier C', () => {
    expect(names(['needs-design'], ['README.md'])).toEqual(['code-reviewer', 'design-reviewer']);
  });

  it('matches labels without regard to case, as GitHub does', () => {
    expect(names(['Needs-Security', 'NEEDS-PERF'])).toEqual([...TIER_A, 'performance-reviewer']);
  });

  it('does not match a label that only starts with a needs label', () => {
    expect(names(['needs-security-later'])).toEqual(BASE);
  });

  it('names the path as the reason when both a path and a label ask for a reviewer', () => {
    const required = requiredReviewers(['needs-security'], ['.github/x.yml'], PATHS);
    expect(required.filter((r) => r.reviewer === 'security-reviewer')).toEqual([
      { reviewer: 'security-reviewer', reason: 'tier A, path .github/x.yml' },
    ]);
  });

  it('cannot be avoided by removing a label when paths still need the reviewer', () => {
    expect(names([], ['scripts/gate.sh'])).toContain('security-reviewer');
  });

  it('counts a file renamed out of a guarded path, since both names are listed', () => {
    expect(names([], ['docs/old-gate.md', 'scripts/gate.sh'])).toEqual(TIER_A);
  });
});

describe('evaluate: who may sign', () => {
  it('passes when every required reviewer approved the head SHA', () => {
    const result = gate(approveAll(...BASE));
    expect(result.pass).toBe(true);
    expect(result.tier).toBe('B');
    expect(result.reviewers.map((r) => r.state)).toEqual(['approved', 'approved']);
  });

  it('passes a docs only PR with code-reviewer alone', () => {
    const result = gate(approveAll('code-reviewer'), [], ['README.md']);
    expect(result.pass).toBe(true);
    expect(result.tier).toBe('C');
  });

  it('fails a tier A PR without security-reviewer', () => {
    expect(gate(approveAll(...BASE), [], ['.github/workflows/ci.yml']).pass).toBe(false);
    expect(gate(approveAll(...TIER_A), [], ['.github/workflows/ci.yml']).pass).toBe(true);
  });

  it('ignores a hygiene-auditor marker as an unknown reviewer', () => {
    const result = gate([
      ...approveAll(...BASE),
      review(marker('hygiene-auditor', 'changes_requested')),
    ]);
    expect(result.pass).toBe(true);
    expect(result.ignored.map((i) => i.reason)).toEqual(['unknown-reviewer']);
  });

  it.each(['CONTRIBUTOR', 'NONE', 'MEMBER', 'OWNER', 'COLLABORATOR'])(
    'ignores author association %s entirely: an allowed login counts',
    (association) => {
      const reviews = BASE.map((r) => review(marker(r), { authorAssociation: association }));
      expect(gate(reviews).pass).toBe(true);
    },
  );

  it.each(['MEMBER', 'OWNER'])(
    'does not count a %s whose login is not on the list for that reviewer',
    (association) => {
      const reviews = [
        ...approveAll('code-reviewer'),
        review(marker('qa-verifier'), { author: 'someone-else', authorAssociation: association }),
      ];
      const result = gate(reviews);
      expect(result.pass).toBe(false);
      expect(result.ignored).toEqual([
        expect.objectContaining({
          author: 'someone-else',
          reviewer: 'qa-verifier',
          reason: 'not-allowed',
        }),
      ]);
    },
  );

  it('checks the list per reviewer name, not across all of them', () => {
    const config: GateConfig = {
      paths: PATHS,
      reviewers: { ...CONFIG.reviewers, 'qa-verifier': ['qa-bot'] },
    };
    const result = gate(approveAll(...BASE), [], PRODUCT, config);
    expect(result.pass).toBe(false);
    expect(result.ignored.map((i) => [i.reviewer, i.reason])).toEqual([
      ['qa-verifier', 'not-allowed'],
    ]);
  });

  // GraphQL drops the [bot] suffix from bot logins, so a bot can look like a listed user.
  it.each(['Bot', 'Mannequin', 'EnterpriseUserAccount', 'Organization', 'unknown'])(
    'does not count an approval from an author of type %s whose login is on the list',
    (authorType) => {
      const reviews = [
        ...approveAll('code-reviewer'),
        review(marker('qa-verifier'), { authorType }),
      ];
      const result = gate(reviews);
      expect(result.pass).toBe(false);
      expect(result.reviewers.find((r) => r.reviewer === 'qa-verifier')?.state).toBe('missing');
      expect(result.ignored).toEqual([
        expect.objectContaining({ author: 'lead', reviewer: 'qa-verifier', reason: 'not-a-user' }),
      ]);
    },
  );

  it('matches the author type exactly', () => {
    const reviews = BASE.map((r) => review(marker(r), { authorType: 'user' }));
    const result = gate(reviews);
    expect(result.pass).toBe(false);
    expect(result.ignored.map((i) => i.reason)).toEqual(BASE.map(() => 'not-a-user'));
  });

  it('does not let a bot block with changes_requested or an edit', () => {
    const reviews = [
      ...approveAll(...BASE),
      review(marker('qa-verifier', 'changes_requested'), { authorType: 'Bot' }),
      review('withdrawn', { authorType: 'Bot', edited: true }),
    ];
    const result = gate(reviews);
    expect(result.pass).toBe(true);
    expect(result.ignored.map((i) => i.reason)).toEqual(['not-a-user']);
  });

  it('matches logins without regard to case, as GitHub does', () => {
    const reviews = BASE.map((r) => review(marker(r), { author: 'LEAD' }));
    expect(gate(reviews).pass).toBe(true);
  });

  it('does not let a login outside the list block with changes_requested', () => {
    const reviews = [
      ...approveAll(...BASE),
      review(marker('qa-verifier', 'changes_requested'), { author: 'drive-by' }),
    ];
    expect(gate(reviews).pass).toBe(true);
  });

  it('fails closed for a required reviewer with no allowed logins', () => {
    const config: GateConfig = {
      paths: PATHS,
      reviewers: { ...CONFIG.reviewers, 'qa-verifier': [] },
    };
    const result = gate(approveAll(...BASE), [], PRODUCT, config);
    expect(result.pass).toBe(false);
    expect(result.reviewers.find((r) => r.reviewer === 'qa-verifier')?.state).toBe('no-signers');
  });

  it('fails closed for a required reviewer missing from the list entirely', () => {
    const rest = Object.fromEntries(
      Object.entries(CONFIG.reviewers).filter(([name]) => name !== 'security-reviewer'),
    );
    const result = gate(approveAll(...ALL), ['needs-security'], PRODUCT, {
      paths: PATHS,
      reviewers: rest,
    });
    expect(result.pass).toBe(false);
    expect(result.reviewers.find((r) => r.reviewer === 'security-reviewer')?.state).toBe(
      'no-signers',
    );
  });

  it('does not mind an empty list for a reviewer that is not required', () => {
    const config: GateConfig = {
      paths: PATHS,
      reviewers: { ...CONFIG.reviewers, 'design-reviewer': [] },
    };
    expect(gate(approveAll(...BASE), [], PRODUCT, config).pass).toBe(true);
  });
});

describe('evaluate: which markers count', () => {
  it('fails and lists who is missing', () => {
    const result = gate(approveAll('code-reviewer'), [], ['scripts/x.sh']);
    expect(result.pass).toBe(false);
    expect(result.reviewers.filter((r) => r.state === 'missing').map((r) => r.reviewer)).toEqual([
      'qa-verifier',
      'security-reviewer',
    ]);
  });

  it('fails with no reviews at all', () => {
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

  it('ignores approvals for an older SHA and says so', () => {
    const reviews = [...approveAll('code-reviewer'), review(marker('qa-verifier', 'approve', OLD))];
    const result = gate(reviews);
    expect(result.pass).toBe(false);
    expect(result.ignored.map((i) => i.reason)).toEqual(['wrong-sha']);
  });

  it('accepts the head SHA given in uppercase', () => {
    const result = evaluate(
      { headSha: HEAD.toUpperCase(), labels: [], files: PRODUCT, reviews: approveAll(...BASE) },
      CONFIG,
    );
    expect(result.pass).toBe(true);
  });

  it('reports a body that mentions a marker but has none on the last line', () => {
    const reviews = [
      ...approveAll(...BASE),
      review(`${marker('qa-verifier', 'changes_requested')}\nthanks`),
    ];
    const result = gate(reviews);
    expect(result.pass).toBe(true);
    expect(result.ignored.map((i) => i.reason)).toEqual(['not-last-line']);
  });

  it('does not list ordinary reviews as ignored', () => {
    expect(gate([...approveAll(...BASE), review('Nice work.')]).ignored).toEqual([]);
  });

  it('ignores unknown reviewer names', () => {
    const result = gate([
      ...approveAll(...BASE),
      review(marker('random-reviewer', 'changes_requested')),
    ]);
    expect(result.pass).toBe(true);
    expect(result.ignored.map((i) => i.reason)).toEqual(['unknown-reviewer']);
  });

  it('ignores an optional reviewer that is not required', () => {
    const reviews = [
      ...approveAll(...BASE),
      review(marker('security-reviewer', 'changes_requested')),
    ];
    expect(gate(reviews).pass).toBe(true);
  });

  it('records who approved, when, and why the reviewer was required', () => {
    const reviews = approveAll(...BASE);
    expect(gate(reviews).reviewers[0]).toEqual({
      reviewer: 'code-reviewer',
      state: 'approved',
      reason: 'tier B, path packages/core/src/index.ts',
      by: 'lead',
      at: reviews[0]?.submittedAt,
      edited: false,
    });
  });
});

describe('evaluate: carry-over', () => {
  it('counts an approval on a commit the head reaches only through clean base merges', () => {
    const reviews = [
      review(marker('code-reviewer', 'approve', MERGED)),
      ...approveAll('qa-verifier'),
    ];
    const result = gate(reviews, [], PRODUCT, CONFIG, [MERGED]);
    expect(result.pass).toBe(true);
    expect(result.carried).toEqual([MERGED]);
    expect(result.reviewers[0]).toMatchObject({ state: 'approved', carriedFrom: MERGED });
    expect(result.reviewers[1]).not.toHaveProperty('carriedFrom');
  });

  it('still ignores an approval on a SHA outside the carry set', () => {
    const reviews = [review(marker('code-reviewer', 'approve', OLD)), ...approveAll('qa-verifier')];
    const result = gate(reviews, [], PRODUCT, CONFIG, [MERGED]);
    expect(result.pass).toBe(false);
    expect(result.ignored.map((i) => i.reason)).toEqual(['wrong-sha']);
  });

  it('carries nothing when no carry set is given', () => {
    const reviews = [
      review(marker('code-reviewer', 'approve', MERGED)),
      ...approveAll('qa-verifier'),
    ];
    expect(gate(reviews).pass).toBe(false);
  });

  it('lets a newer block on the head override a carried approval', () => {
    const reviews = [
      review(marker('code-reviewer', 'approve', MERGED)),
      ...approveAll('qa-verifier'),
      review(marker('code-reviewer', 'changes_requested')),
    ];
    expect(gate(reviews, [], PRODUCT, CONFIG, [MERGED]).pass).toBe(false);
  });

  it('keeps an older block on any SHA once it is the newest review', () => {
    const reviews = [
      ...approveAll(...BASE),
      review(marker('code-reviewer', 'changes_requested', MERGED)),
    ];
    expect(gate(reviews, [], PRODUCT, CONFIG, [MERGED]).pass).toBe(false);
  });

  it('does not carry a dismissed approval', () => {
    const reviews = [
      review(marker('code-reviewer', 'approve', MERGED), { dismissed: true }),
      ...approveAll('qa-verifier'),
    ];
    const result = gate(reviews, [], PRODUCT, CONFIG, [MERGED]);
    expect(result.pass).toBe(false);
    expect(result.ignored.map((i) => i.reason)).toEqual(['dismissed-approve']);
  });

  it('does not carry an edited approval', () => {
    const reviews = [
      ...approveAll('qa-verifier'),
      review(marker('code-reviewer', 'approve', MERGED), { edited: true }),
    ];
    expect(gate(reviews, [], PRODUCT, CONFIG, [MERGED]).pass).toBe(false);
  });

  it('accepts carried SHAs in uppercase', () => {
    const reviews = [
      review(marker('code-reviewer', 'approve', MERGED)),
      ...approveAll('qa-verifier'),
    ];
    expect(gate(reviews, [], PRODUCT, CONFIG, [MERGED.toUpperCase()]).pass).toBe(true);
  });

  it('rejects a carried SHA that is not 40 hex characters', () => {
    expect(() => gate([], [], PRODUCT, CONFIG, ['abc'])).toThrow(/carried SHA/);
  });
});

describe('evaluate: ordering, edits and dismissals', () => {
  it('blocks when changes_requested comes after approve for the same SHA', () => {
    const reviews = [
      ...approveAll(...BASE),
      review(`Found a bug.\n${marker('qa-verifier', 'changes_requested')}`),
    ];
    const result = gate(reviews);
    expect(result.pass).toBe(false);
    expect(result.reviewers.find((r) => r.reviewer === 'qa-verifier')?.state).toBe(
      'changes_requested',
    );
  });

  it('passes when approve comes after changes_requested', () => {
    expect(
      gate([review(marker('qa-verifier', 'changes_requested')), ...approveAll(...BASE)]).pass,
    ).toBe(true);
  });

  it('orders by submitted time, not by input order', () => {
    const late = review(marker('qa-verifier', 'changes_requested'), {
      submittedAt: '2030-01-01T00:00:00Z',
    });
    expect(gate([late, ...approveAll(...BASE)]).pass).toBe(false);
  });

  it('fails closed when approve and changes_requested share a timestamp', () => {
    const at = '2026-10-07T12:00:00Z';
    const reviews = [
      ...approveAll('code-reviewer'),
      review(marker('qa-verifier', 'changes_requested'), { submittedAt: at }),
      review(marker('qa-verifier'), { submittedAt: at }),
    ];
    expect(gate(reviews).pass).toBe(false);
  });

  // Approve the head, then request changes quoting an old SHA: the newer review is the
  // reviewer's current decision, so it must block.
  it('blocks when the newest review requests changes for an older SHA', () => {
    const result = gate([
      ...approveAll(...BASE),
      review(marker('qa-verifier', 'changes_requested', OLD)),
    ]);
    expect(result.pass).toBe(false);
    expect(result.reviewers.find((r) => r.reviewer === 'qa-verifier')).toMatchObject({
      state: 'changes_requested',
      sha: OLD,
    });
    expect(result.ignored).toEqual([]);
  });

  it('lets a newer approval for the head lift changes requested on an older SHA', () => {
    const reviews = [
      review(marker('qa-verifier', 'changes_requested', OLD)),
      ...approveAll(...BASE),
    ];
    expect(gate(reviews).pass).toBe(true);
  });

  it('does not let a newer approval for an older SHA lift a block', () => {
    const reviews = [
      ...approveAll('code-reviewer'),
      review(marker('qa-verifier', 'changes_requested')),
      review(marker('qa-verifier', 'approve', OLD)),
    ];
    const result = gate(reviews);
    expect(result.pass).toBe(false);
    expect(result.ignored.map((i) => i.reason)).toEqual(['wrong-sha']);
  });

  it('still ignores changes requested on an older SHA from a login that may not sign', () => {
    const reviews = [
      ...approveAll(...BASE),
      review(marker('qa-verifier', 'changes_requested', OLD), { author: 'drive-by' }),
    ];
    const result = gate(reviews);
    expect(result.pass).toBe(true);
    expect(result.ignored.map((i) => i.reason)).toEqual(['not-allowed']);
  });

  it('keeps blocking when a later changes_requested is edited after an earlier approve', () => {
    const reviews = [
      ...approveAll(...BASE),
      review(marker('qa-verifier', 'changes_requested'), { edited: true }),
    ];
    const result = gate(reviews);
    expect(result.pass).toBe(false);
    expect(result.reviewers.find((r) => r.reviewer === 'qa-verifier')).toMatchObject({
      state: 'changes_requested',
      edited: true,
    });
  });

  it('never lets an edited marker approve, even one that now says approve', () => {
    const result = gate([
      ...approveAll('code-reviewer'),
      review(marker('qa-verifier'), { edited: true }),
    ]);
    expect(result.pass).toBe(false);
    expect(result.reviewers.find((r) => r.reviewer === 'qa-verifier')?.state).toBe(
      'changes_requested',
    );
  });

  it('does not let a block edited into an approve bring an older approve back', () => {
    const reviews = [...approveAll(...BASE), review(marker('qa-verifier'), { edited: true })];
    expect(gate(reviews).pass).toBe(false);
  });

  it('lets fresh reviews after an edited one decide again, one per reviewer', () => {
    const reviews = [
      ...approveAll(...BASE),
      review(marker('qa-verifier', 'changes_requested'), { edited: true }),
      ...approveAll(...BASE),
    ];
    expect(gate(reviews).pass).toBe(true);
  });

  it('keeps every reviewer the login may sign for blocked until each gets a fresh review', () => {
    const reviews = [
      ...approveAll(...TIER_A),
      review(marker('qa-verifier', 'changes_requested'), { edited: true }),
      review(marker('qa-verifier')),
    ];
    const result = gate(reviews, [], ['scripts/x.sh']);
    expect(result.pass).toBe(false);
    expect(result.reviewers.map((r) => [r.reviewer, r.state])).toEqual([
      ['code-reviewer', 'changes_requested'],
      ['qa-verifier', 'approved'],
      ['security-reviewer', 'changes_requested'],
    ]);
  });

  // Each of these started as a later changes_requested review and was then edited.
  it.each([
    ['the SHA changed', marker('qa-verifier', 'changes_requested', OLD)],
    ['the reviewer renamed', marker('design-reviewer', 'changes_requested')],
    [
      'a line appended after the marker',
      `${marker('qa-verifier', 'changes_requested')}\nnever mind`,
    ],
    ['the marker removed', 'Removed my review.'],
    ['the body replaced with "withdrawn"', 'withdrawn'],
    ['the verdict flipped to approve', marker('qa-verifier')],
  ])('keeps blocking when an edited review has %s', (_name, body) => {
    const result = gate([...approveAll(...BASE), review(body, { edited: true })]);
    expect(result.pass).toBe(false);
    expect(result.reviewers.find((r) => r.reviewer === 'qa-verifier')).toMatchObject({
      state: 'changes_requested',
      edited: true,
    });
  });

  it('passes again once fresh valid reviews follow such an edit', () => {
    const reviews = [
      ...approveAll(...BASE),
      review('withdrawn', { edited: true }),
      ...approveAll(...BASE),
    ];
    expect(gate(reviews).pass).toBe(true);
  });

  it('ignores edited reviews from logins that may not sign', () => {
    const reviews = [
      ...approveAll(...BASE),
      review('withdrawn', { author: 'drive-by', edited: true }),
      review(marker('qa-verifier', 'changes_requested'), { author: 'drive-by', edited: true }),
    ];
    const result = gate(reviews);
    expect(result.pass).toBe(true);
    expect(result.ignored.map((i) => [i.author, i.reason])).toEqual([['drive-by', 'not-allowed']]);
  });

  it('lets an edited review block only the reviewers its author may sign for', () => {
    const config: GateConfig = {
      paths: PATHS,
      reviewers: { ...CONFIG.reviewers, 'qa-verifier': ['qa-bot'] },
    };
    const reviews = [
      ...approveAll('code-reviewer'),
      review(marker('qa-verifier'), { author: 'qa-bot' }),
      review('withdrawn', { edited: true }),
    ];
    const result = gate(reviews, [], PRODUCT, config);
    expect(result.reviewers.map((r) => [r.reviewer, r.state])).toEqual([
      ['code-reviewer', 'changes_requested'],
      ['qa-verifier', 'approved'],
    ]);
  });

  it('treats an edited dismissed review as a block too', () => {
    const reviews = [
      ...approveAll(...BASE),
      review(marker('qa-verifier'), { edited: true, dismissed: true }),
    ];
    expect(gate(reviews).pass).toBe(false);
  });

  it('keeps changes_requested from a dismissed review blocking', () => {
    const reviews = [
      ...approveAll(...BASE),
      review(marker('qa-verifier', 'changes_requested'), { dismissed: true }),
    ];
    const result = gate(reviews);
    expect(result.pass).toBe(false);
    expect(result.reviewers.find((r) => r.reviewer === 'qa-verifier')?.state).toBe(
      'changes_requested',
    );
  });

  it('does not count an approval from a dismissed review', () => {
    const reviews = [
      ...approveAll('code-reviewer'),
      review(marker('qa-verifier'), { dismissed: true }),
    ];
    const result = gate(reviews);
    expect(result.pass).toBe(false);
    expect(result.ignored.map((i) => i.reason)).toEqual(['dismissed-approve']);
  });

  it('rejects a head SHA that is not 40 hex characters', () => {
    expect(() => evaluate({ headSha: 'abc', labels: [], files: [], reviews: [] }, CONFIG)).toThrow(
      /head SHA/,
    );
  });

  it('rejects a review with an unreadable timestamp instead of guessing its order', () => {
    expect(() => gate([review(marker('qa-verifier'), { submittedAt: 'yesterday' })])).toThrow(
      /timestamp/,
    );
  });
});

describe('formatReport', () => {
  it('shows a pass with the tier, every reviewer and no ignored markers', () => {
    const report = formatReport(gate(approveAll(...BASE)));
    expect(report).toContain(`review-gate: PASS for ${HEAD}`);
    expect(report).toContain('tier B, path packages/core/src/index.ts');
    expect(report).toMatch(/code-reviewer\s+approved by lead/);
    expect(report).toContain('ignored markers: none');
  });

  it('shows what is missing, blocking or unsigned, and every ignored marker with its reason', () => {
    const reviews = [
      review(marker('code-reviewer', 'changes_requested'), {
        submittedAt: '2026-10-07T10:00:00.000Z',
      }),
      review(marker('qa-verifier', 'approve', OLD), { submittedAt: '2026-10-07T10:01:00.000Z' }),
      review(marker('security-reviewer'), {
        author: 'drive-by',
        authorAssociation: 'NONE',
        submittedAt: '2026-10-07T10:02:00.000Z',
      }),
      review(marker('qa-verifier'), { edited: true, submittedAt: '2026-10-07T10:03:00.000Z' }),
    ];
    const config: GateConfig = {
      paths: PATHS,
      reviewers: { ...CONFIG.reviewers, 'performance-reviewer': [] },
    };
    const report = formatReport(gate(reviews, ['needs-perf'], ['scripts/x.sh'], config));
    expect(report).toContain('review-gate: FAIL');
    expect(report).toMatch(/code-reviewer\s+changes requested by lead/);
    expect(report).toMatch(
      /qa-verifier\s+changes requested by lead at .* \(edited review; post a fresh one\)/,
    );
    expect(report).toMatch(
      /security-reviewer\s+changes requested by lead at .* \(edited review; post a fresh one\)/,
    );
    expect(report).toMatch(/performance-reviewer\s+no logins allowed to sign \(label needs-perf\)/);
    expect(report).toContain('ignored markers:');
    expect(report).toContain(
      '  lead (User, CONTRIBUTOR) at 2026-10-07T10:01:00.000Z for qa-verifier: approval for another SHA',
    );
    expect(report).toContain(
      '  drive-by (User, NONE) at 2026-10-07T10:02:00.000Z for security-reviewer: login not allowed to sign for this reviewer',
    );
  });

  it('names the older SHA a block was requested on', () => {
    const report = formatReport(gate([review(marker('code-reviewer', 'changes_requested', OLD))]));
    expect(report).toMatch(
      new RegExp(`code-reviewer\\s+changes requested by lead at .* \\(on ${OLD}\\)`),
    );
  });

  it('names the commit a carried approval was given on, and the carry set', () => {
    const reviews = [
      review(marker('code-reviewer', 'approve', MERGED)),
      ...approveAll('qa-verifier'),
    ];
    const result = evaluate(
      {
        headSha: HEAD,
        labels: [],
        files: PRODUCT,
        reviews,
        carry: [MERGED],
        carryNote: 'x is not a merge',
      },
      CONFIG,
    );
    const report = formatReport(result);
    expect(report).toMatch(
      new RegExp(
        `code-reviewer\\s+approved by lead at .* \\(on ${MERGED}, carried over clean base merges\\)`,
      ),
    );
    expect(report).toContain(`carry-over: approvals on these commits also count:\n  ${MERGED}\n`);
    expect(report).toContain('carry-over stopped: x is not a merge');
  });

  it('says why nothing carries', () => {
    const result = evaluate(
      { headSha: HEAD, labels: [], files: PRODUCT, reviews: [], carryNote: 'history is shallow' },
      CONFIG,
    );
    expect(formatReport(result)).toContain('carry-over: none (history is shallow)');
    expect(formatReport(gate([]))).toContain('carry-over: none (not checked)');
  });

  // A bot can share a listed user's login, so the type is what tells them apart.
  it('names a bot author as not a user and shows its type', () => {
    const report = formatReport(gate([review(marker('code-reviewer'), { authorType: 'Bot' })]));
    expect(report).toMatch(
      /lead \(Bot, CONTRIBUTOR\) at .* for code-reviewer: author is not a user account/,
    );
  });

  it('labels an ignored review without a reviewer name', () => {
    const report = formatReport(gate([review(`drefyn-review sha=${HEAD}`, { author: 'x' })]));
    expect(report).toMatch(/x \(User, CONTRIBUTOR\) at .*: no valid marker on the last line/);
  });
});

describe('statusDescription', () => {
  it('summarises a pass', () => {
    expect(statusDescription(gate(approveAll(...BASE)))).toBe(
      '2 of 2 reviewers approved this commit',
    );
  });

  it('says how many approvals were carried over', () => {
    const reviews = [
      review(marker('code-reviewer', 'approve', MERGED)),
      ...approveAll('qa-verifier'),
    ];
    expect(statusDescription(gate(reviews, [], PRODUCT, CONFIG, [MERGED]))).toBe(
      '2 of 2 reviewers approved; 1 carried over clean base merges',
    );
  });

  it('names blockers, missing and unsigned reviewers', () => {
    const config: GateConfig = {
      paths: PATHS,
      reviewers: { ...CONFIG.reviewers, 'security-reviewer': [] },
    };
    const result = gate(
      [review(marker('code-reviewer', 'changes_requested'))],
      [],
      ['scripts/x.sh'],
      config,
    );
    expect(statusDescription(result)).toBe(
      'changes requested: code-reviewer; missing: qa-verifier; no signers: security-reviewer',
    );
  });

  it('stays within the 140 character limit of commit statuses', () => {
    const config: GateConfig = { paths: PATHS, reviewers: {} };
    const text = statusDescription(
      gate([], ['needs-security', 'needs-perf', 'needs-design'], PRODUCT, config),
    );
    expect(text.length).toBeLessThanOrEqual(140);
    expect(text.startsWith('no signers: code-reviewer')).toBe(true);
  });
});
