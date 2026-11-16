import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The organization ruleset runs this file for PRs into staging and main. These checks pin
// the properties that make its result trustworthy, so a later edit cannot quietly drop one.
const path = fileURLToPath(
  new URL('../../../.github/workflows/review-gate-required.yml', import.meta.url),
);
const text = readFileSync(path, 'utf8');
const code = text
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

describe('review-gate-required.yml', () => {
  it('runs only on pull_request events into staging and main', () => {
    expect(code).toMatch(/^on:\n {2}pull_request:\n/m);
    expect(code).toMatch(/^ {4}branches: \[staging, main\]$/m);
    for (const trigger of [
      'pull_request_target',
      'pull_request_review',
      'workflow_dispatch',
      'workflow_run',
      'push',
      'schedule',
    ]) {
      expect(code).not.toMatch(new RegExp(`^ {2}${trigger}:`, 'm'));
    }
  });

  it('holds read scopes only and posts no status', () => {
    expect(code).toMatch(/^permissions: \{\}$/m);
    expect(code).not.toMatch(/:\s*write\b/);
    expect(code).not.toMatch(/write-all/);
    expect(code).not.toMatch(/\/statuses\//);
    const scopes = [...code.matchAll(/^ {6}([a-z-]+): (read|none)\b/gm)].map((m) => m[1]);
    expect(scopes.sort()).toEqual(['contents', 'pull-requests']);
  });

  it('refuses to run unless GitHub took the file from development', () => {
    expect(code).toContain('WORKFLOW_REF: ${{ github.workflow_ref }}');
    expect(code).toContain(
      'qomiralabs/drefyn/.github/workflows/review-gate-required.yml@refs/heads/development)',
    );
    const refuse = code.indexOf('WORKFLOW_REF: ${{ github.workflow_ref }}');
    const checkout = code.indexOf('uses: actions/checkout@');
    expect(refuse).toBeGreaterThan(-1);
    expect(refuse).toBeLessThan(checkout);
  });

  it('checks out the gate at the workflow commit and never the PR', () => {
    expect(code).toContain('ref: ${{ github.workflow_sha }}');
    expect(code).toContain('persist-credentials: false');
    expect(code).not.toMatch(/github\.head_ref/);
    expect(code).not.toMatch(/pull_request\.head\.ref/);
    expect(code).not.toMatch(/pull_request\.base\.sha/);
    expect(code.match(/uses: actions\/checkout@/g)).toHaveLength(1);
  });

  it('fails unless the gate judged the commit this run is for', () => {
    expect(code).toContain('EVENT_HEAD_SHA: ${{ github.event.pull_request.head.sha }}');
    expect(code).toContain('GATE_SHA: ${{ steps.gate.outputs.sha }}');
    expect(code).toContain('[ "$GATE_SHA" != "$EVENT_HEAD_SHA" ]');
  });

  it('pins every action to a full commit SHA', () => {
    const uses = [...code.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) expect(ref).toMatch(/@[0-9a-f]{40}$/);
  });
});
