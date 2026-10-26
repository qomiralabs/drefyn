import { describe, expect, it } from 'vitest';
import { IMAGE, MARKER, plan } from '../scripts/in-container.ts';

const paths = { repo: '/home/me/drefyn', pkg: 'packages/ui', cli: '/cli.js', uid: 501, gid: 20 };
const visual = ['playwright', 'test', '--project=visual'];
const inside = { platform: 'linux', env: { [MARKER]: IMAGE }, browsers: true };

describe('the visual runner', () => {
  it('pins the image by version and digest', () => {
    expect(IMAGE).toMatch(/^mcr\.microsoft\.com\/playwright:v1\.64\.1-noble@sha256:[0-9a-f]{64}$/);
  });

  it('starts the pinned image from a macOS host and never runs Playwright there', () => {
    expect(plan(visual, { platform: 'darwin', env: {}, browsers: false }, paths)).toEqual({
      kind: 'docker',
      command: [
        'docker',
        'run',
        '--rm',
        '--ipc=host',
        '--user',
        '501:20',
        '-e',
        'HOME=/tmp',
        '-e',
        `${MARKER}=${IMAGE}`,
        '-v',
        '/home/me/drefyn:/work',
        '-w',
        '/work/packages/ui',
        IMAGE,
        'node',
        'scripts/in-container.ts',
        ...visual,
      ],
    });
  });

  it('starts the image from a Linux host that is not the image', () => {
    expect(plan(visual, { platform: 'linux', env: {}, browsers: false }, paths).kind).toBe(
      'docker',
    );
  });

  it('runs Playwright inside the pinned image', () => {
    expect(plan([...visual, '--update-snapshots'], inside, paths)).toEqual({
      kind: 'run',
      command: ['/cli.js', 'test', '--project=visual', '--update-snapshots'],
    });
  });

  it('refuses a marker without the image browsers, so a host cannot pretend', () => {
    expect(() => plan(visual, { ...inside, browsers: false }, paths)).toThrow(
      /not inside the pinned Playwright image/,
    );
    expect(() => plan(visual, { ...inside, platform: 'darwin' }, paths)).toThrow(
      /not inside the pinned Playwright image/,
    );
  });

  it('refuses a marker naming another image', () => {
    expect(() =>
      plan(visual, { ...inside, env: { [MARKER]: 'mcr.microsoft.com/playwright:latest' } }, paths),
    ).toThrow(/not inside the pinned Playwright image/);
  });

  it('only runs Playwright', () => {
    expect(() => plan(['sh', '-c', 'true'], inside, paths)).toThrow(/runs only playwright/);
    expect(() => plan([], inside, paths)).toThrow(/runs only playwright/);
  });
});
