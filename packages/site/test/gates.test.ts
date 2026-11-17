import { readFileSync } from 'node:fs';
import { gzipSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  firstResponseVerdict,
  jsProblem,
  lighthouseProblems,
  type Scores,
} from '../gates/budgets.ts';
import { CONTROLS, judge, measured, outcomes } from '../gates/controls.ts';
import {
  BREACH_ENV,
  BREACHES,
  breachFrom,
  buildGateSet,
  incidentUpdatesFrom,
  LARGEST_INCIDENT_UPDATES,
} from '../gates/pages.ts';
import { IMAGE } from '../gates/image.ts';
import { noisePng } from '../gates/png.ts';

const perfect: Scores = {
  performance: 100,
  accessibility: 100,
  'best-practices': 100,
  seo: 100,
};

describe('lighthouseProblems', () => {
  it('passes a page at the minimum score on each surface', () => {
    const at = (n: number): Scores => ({
      performance: n,
      accessibility: n,
      'best-practices': n,
      seo: n,
    });
    expect(lighthouseProblems('docs', at(95), 5_000)).toEqual([]);
    expect(lighthouseProblems('status', at(98), 1_000)).toEqual([]);
  });

  it('names every category under the minimum and a missing score', () => {
    expect(lighthouseProblems('docs', { ...perfect, seo: 94, accessibility: null }, 500)).toEqual([
      'accessibility has no score',
      'seo 94 is under 95',
    ]);
    expect(lighthouseProblems('status', { ...perfect, performance: 97 }, 500)).toEqual([
      'performance 97 is under 98',
    ]);
  });

  it('holds status pages, and only status pages, to the LCP limit', () => {
    expect(lighthouseProblems('status', perfect, 1_001)).toEqual(['LCP 1001 ms is over 1000 ms']);
    expect(lighthouseProblems('status', perfect, Number.NaN)).toEqual([
      'LCP NaN ms is over 1000 ms',
    ]);
    expect(lighthouseProblems('docs', perfect, 3_000)).toEqual([]);
  });
});

describe('jsProblem', () => {
  it('fails a page at the limit, as the renderer does', () => {
    expect(jsProblem('docs', 89_999)).toBeUndefined();
    expect(jsProblem('docs', 90_000)).toBe('90000 gzipped bytes of JS is not under 90000');
    expect(jsProblem('status', 49_999)).toBeUndefined();
    expect(jsProblem('status', 50_000)).toBe('50000 gzipped bytes of JS is not under 50000');
  });
});

describe('firstResponseVerdict', () => {
  it('warns from the target and fails from the hard limit', () => {
    expect(firstResponseVerdict(13_999)).toBe('ok');
    expect(firstResponseVerdict(14_000)).toBe('warn');
    expect(firstResponseVerdict(15_999)).toBe('warn');
    expect(firstResponseVerdict(16_000)).toBe('fail');
  });
});

describe('breachFrom', () => {
  it('reads no breach as the real set and refuses a name it does not know', () => {
    expect(breachFrom({})).toBeUndefined();
    expect(breachFrom({ [BREACH_ENV]: '' })).toBeUndefined();
    expect(breachFrom({ [BREACH_ENV]: 'axe' })).toBe('axe');
    expect(() => breachFrom({ [BREACH_ENV]: 'nope' })).toThrow(BREACH_ENV);
  });
});

describe('the gate set', () => {
  const real = buildGateSet(undefined);
  const gz = (html: string) => gzipSync(html, { level: 9 }).length;

  it('has a page of each surface and one largest incident', () => {
    expect(real.pages.map((p) => `${p.surface} ${p.path}`)).toEqual([
      'docs /docs/quickstart',
      'status /status/',
      'status /status/incident',
    ]);
    expect(real.pages.filter((p) => p.largestIncident).map((p) => p.id)).toEqual([
      'status-incident',
    ]);
  });

  it('keeps the largest incident under the warning target', () => {
    const incident = real.pages.find((p) => p.largestIncident);
    expect(gz(incident?.html ?? '')).toBeLessThan(14_000);
    expect(LARGEST_INCIDENT_UPDATES).toBeLessThan(incidentUpdatesFrom(14_000));
  });

  it('builds the same bytes twice', () => {
    expect(buildGateSet(undefined).pages.map((p) => p.html)).toEqual(real.pages.map((p) => p.html));
  });

  it('changes only the page a breach names, keeping its id and path', () => {
    for (const breach of BREACHES.filter((b) => b !== 'first-response-fail')) {
      const broken = buildGateSet(breach);
      expect(broken.pages.map((p) => [p.id, p.path])).toEqual(
        real.pages.map((p) => [p.id, p.path]),
      );
      const changed = broken.pages.filter((p, i) => p.html !== real.pages[i]?.html);
      const scriptsChanged = ['/docs.js', '/status.js'].some(
        (href) =>
          !broken.assets.get(href)?.body.equals(real.assets.get(href)?.body ?? Buffer.alloc(0)),
      );
      expect(changed.length + (scriptsChanged ? 1 : 0), breach).toBeGreaterThan(0);
      expect(changed.length, breach).toBeLessThanOrEqual(1);
    }
  });

  it('puts the warning breach inside the warning band', () => {
    const incident = buildGateSet('first-response-warn').pages.find((p) => p.largestIncident);
    const bytes = gz(incident?.html ?? '');
    expect(bytes).toBeGreaterThanOrEqual(14_000);
    expect(bytes).toBeLessThan(16_000);
  });

  it('refuses the incident past the hard limit at render', () => {
    expect(() => buildGateSet('first-response-fail')).toThrow(/"budget":"first_response"/);
  });

  it('serves scripts over budget while declaring them under it', () => {
    const docs = buildGateSet('docs-js').assets.get('/docs.js')?.body ?? Buffer.alloc(0);
    const status = buildGateSet('status-js').assets.get('/status.js')?.body ?? Buffer.alloc(0);
    expect(gzipSync(docs, { level: 9 }).length).toBeGreaterThanOrEqual(90_000);
    expect(gzipSync(status, { level: 9 }).length).toBeGreaterThanOrEqual(50_000);
  });
});

describe('noisePng', () => {
  it('writes a valid PNG of exactly the pixels asked for', () => {
    const png = noisePng(4, 3, 7);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.readUInt32BE(16)).toBe(4);
    expect(png.readUInt32BE(20)).toBe(3);
    const idatLength = png.readUInt32BE(33);
    expect(png.subarray(37, 41).toString('latin1')).toBe('IDAT');
    const raw = inflateSync(png.subarray(41, 41 + idatLength));
    expect(raw.length).toBe(3 * (4 * 3 + 1));
    expect(noisePng(4, 3, 7).equals(png)).toBe(true);
    expect(noisePng(4, 3, 8).equals(png)).toBe(false);
  });
});

describe('controls', () => {
  it('cover every breach exactly once', () => {
    expect(CONTROLS.map((c) => c.breach).sort()).toEqual([...BREACHES].sort());
  });

  const report = (status: string, title = 'docs-article loads its JS budget', message = '') => ({
    suites: [
      {
        suites: [
          {
            specs: [{ title, tests: [{ status, results: [{ error: { message } }] }] }],
          },
        ],
      },
    ],
  });
  const fail = { kind: 'fail', titles: /^docs-article loads/, message: /not under/ } as const;

  it('reads nested specs, errors and warnings from a JSON report', () => {
    expect(outcomes(report('unexpected', 't', 'boom'))).toEqual([
      { title: 't', status: 'unexpected', message: 'boom', warned: false },
    ]);
    const warned = {
      specs: [
        {
          title: 'w',
          tests: [{ status: 'expected', annotations: [{ type: 'warning' }], results: [] }],
        },
      ],
    };
    expect(outcomes({ suites: [warned] })[0]?.warned).toBe(true);
    expect(outcomes({})).toEqual([]);
  });

  it('keeps only the Lighthouse lines a run printed', () => {
    const printed = {
      suites: [
        {
          specs: [
            {
              title: 't',
              tests: [
                {
                  status: 'expected',
                  results: [
                    {
                      stdout: [
                        { text: 'lighthouse status-home: performance 99, LCP 812 ms on img\n' },
                        { text: 'js status-home: 4100 gzipped bytes\n' },
                        {},
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(measured(printed)).toEqual([
      'lighthouse status-home: performance 99, LCP 812 ms on img',
    ]);
    expect(measured({})).toEqual([]);
  });

  it('accepts only the expected test failing for the expected reason', () => {
    const caught = outcomes(report('unexpected', undefined, 'x is not under 90000'));
    expect(judge(fail, 1, caught, '')).toEqual([]);
    expect(judge(fail, 0, outcomes(report('expected')), '')).toEqual([
      'the run passed',
      'no test failed',
    ]);
    expect(
      judge(fail, 1, outcomes(report('unexpected', 'status-home x', 'not under')), ''),
    ).toEqual(['an unrelated test failed: status-home x']);
    expect(judge(fail, 1, outcomes(report('unexpected', undefined, 'timeout')), '')[0]).toMatch(
      /failed for another reason/,
    );
  });

  it('wants a warning on a passing run, and a refusal in the output', () => {
    const warn = { kind: 'warn', titles: /^w/ } as const;
    expect(
      judge(warn, 0, [{ title: 'w', status: 'expected', message: '', warned: true }], ''),
    ).toEqual([]);
    expect(
      judge(warn, 1, [{ title: 'w', status: 'unexpected', message: '', warned: false }], ''),
    ).toEqual(['a warning must not fail the run', 'no warning on a test matching /^w/']);
    const refused = { kind: 'refused', output: /budget_exceeded/ } as const;
    expect(judge(refused, 1, [], 'site.budget_exceeded')).toEqual([]);
    expect(judge(refused, 0, [], '')).toEqual(['the run passed']);
    expect(judge(refused, 1, [], 'other')).toEqual(['the output never matched /budget_exceeded/']);
  });
});

describe('the site workflow', () => {
  const workflow = readFileSync(
    new URL('../../../.github/workflows/site.yml', import.meta.url),
    'utf8',
  );
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    devDependencies: Record<string, string>;
  };

  it('pins every action to a full commit SHA', () => {
    const uses = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1] ?? '');
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.filter((u) => !/^[^@\s]+@[0-9a-f]{40}$/.test(u))).toEqual([]);
  });

  it('starts every job in the image the visual guard expects, on the same Playwright', () => {
    const images = [...workflow.matchAll(/DREFYN_PLAYWRIGHT_IMAGE:\s*(\S+)/g)].map((m) => m[1]);
    // The csp job and the four gate jobs.
    expect(images).toHaveLength(5);
    expect(new Set(images)).toEqual(new Set([IMAGE]));
    expect(IMAGE).toContain(
      `playwright:v${pkg.devDependencies['@playwright/test'] ?? ''}-noble@sha256:`,
    );
  });
});
