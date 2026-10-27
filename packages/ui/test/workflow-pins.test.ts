import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IMAGE } from '../scripts/in-container.ts';
import { pinProblems } from '../scripts/workflow-pins.ts';
import { WORKFLOWS } from './fixtures/workflows.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name: string): string => {
  const text = WORKFLOWS[name.replace(/\.yml$/, '')];
  if (text === undefined) throw new Error(`no workflow fixture ${name}`);
  return text;
};
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  devDependencies: Record<string, string>;
};
const playwright = pkg.devDependencies['@playwright/test'] ?? '';

describe('the ui workflow pins', () => {
  it('passes for the real workflow, image and Playwright version', () => {
    const workflow = readFileSync(join(root, '..', '..', '.github', 'workflows', 'ui.yml'), 'utf8');
    expect(pinProblems({ workflow, image: IMAGE, playwright })).toEqual([]);
  });

  it('keeps playwright-core on the same version as @playwright/test', () => {
    expect(pkg.devDependencies['playwright-core']).toBe(playwright);
  });

  it('passes a fixture with SHA pins, a local action and a digest pinned image', () => {
    expect(pinProblems({ workflow: fixture('pinned.yml'), image: IMAGE, playwright })).toEqual([]);
  });

  it('fails a container image with a tag and no digest', () => {
    expect(
      pinProblems({ workflow: fixture('tag-only-image.yml'), image: IMAGE, playwright }),
    ).toEqual([
      'line 6: image mcr.microsoft.com/playwright:v1.64.1-noble has no @sha256 digest',
      `line 6: image mcr.microsoft.com/playwright:v1.64.1-noble is not ${IMAGE}`,
    ]);
  });

  it('fails a container image on another Playwright version', () => {
    const problems = pinProblems({
      workflow: fixture('mismatched-version.yml'),
      image: IMAGE,
      playwright,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^line 7: image mcr\.microsoft\.com\/playwright:v1\.63\.0-noble@/);
  });

  it('fails uses by tag, by short SHA and a docker action without a digest', () => {
    expect(pinProblems({ workflow: fixture('uses-by-tag.yml'), image: IMAGE, playwright })).toEqual(
      [
        'line 7: actions/checkout@v7 is not pinned to a full commit SHA',
        'line 9: actions/setup-node@8207627 is not pinned to a full commit SHA',
        'line 10: docker://alpine:3.22 has no @sha256 digest',
      ],
    );
  });

  it('fails browsers installed on the runner instead of taken from the image', () => {
    expect(
      pinProblems({ workflow: fixture('host-browsers.yml'), image: IMAGE, playwright }),
    ).toEqual(['line 8: playwright install puts host browsers in CI; run in the pinned image']);
  });

  it('fails an image constant with no digest or on another version', () => {
    const workflow = fixture('pinned.yml').replace(/^\s+container:\n\s+image: .*\n/m, '');
    expect(
      pinProblems({ workflow, image: 'mcr.microsoft.com/playwright:v1.64.1-noble', playwright }),
    ).toEqual([
      'runner image mcr.microsoft.com/playwright:v1.64.1-noble is not a Playwright noble tag pinned by @sha256 digest',
    ]);
    const older = IMAGE.replace('v1.64.1', 'v1.63.0');
    expect(pinProblems({ workflow, image: older, playwright })).toEqual([
      `runner image is Playwright 1.63.0 but @playwright/test is ${playwright}`,
    ]);
  });
});
