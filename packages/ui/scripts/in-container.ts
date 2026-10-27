// Runs Playwright for screenshots only inside the pinned Linux image, where fonts render
// the same on every machine. Anywhere else it starts that image through Docker and runs
// itself there, so a baseline is never made or compared on a host.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IMAGE =
  'mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea';
// Set by the docker run below. On its own it proves nothing, so the image's browser
// folder and Linux are required too.
export const MARKER = 'DREFYN_PLAYWRIGHT_IMAGE';
const IMAGE_BROWSERS = '/ms-playwright';

export interface Where {
  platform: string;
  arch: string;
  env: Readonly<Record<string, string | undefined>>;
  browsers: boolean;
}

export interface Paths {
  repo: string;
  pkg: string;
  cli: string;
  uid: number;
  gid: number;
}

// The one test of being inside the pinned image, shared with the visual spec so a
// marker set by hand on a host can neither compare nor write a baseline. The digest names
// an amd64 and an arm64 build with separate browser binaries, so only the amd64 build
// that CI runners use counts.
export const insidePinnedImage = (where: Where): boolean =>
  where.env[MARKER] === IMAGE &&
  where.platform === 'linux' &&
  where.arch === 'x64' &&
  where.browsers;

export const currentPlace = (): Where => ({
  platform: process.platform,
  arch: process.arch,
  env: process.env,
  browsers: existsSync(IMAGE_BROWSERS),
});

export interface Plan {
  kind: 'run' | 'docker';
  command: string[];
}

export function plan(args: readonly string[], where: Where, paths: Paths): Plan {
  if (args[0] !== 'playwright') {
    throw new Error('in-container runs only playwright, for example: playwright test');
  }
  const marker = where.env[MARKER];
  if (marker === undefined) {
    return {
      kind: 'docker',
      command: [
        'docker',
        'run',
        '--rm',
        // Apple Silicon runs the amd64 build under emulation, so a baseline made on a
        // laptop matches the one CI compares against.
        '--platform',
        'linux/amd64',
        '--ipc=host',
        // Screenshots of a static build need no network, and none means none can leak.
        '--network',
        'none',
        // Files written to the mounted checkout stay owned by the caller.
        '--user',
        `${paths.uid}:${paths.gid}`,
        '-e',
        'HOME=/tmp',
        '-e',
        `${MARKER}=${IMAGE}`,
        '-v',
        `${paths.repo}:/work`,
        '-w',
        `/work/${paths.pkg}`,
        IMAGE,
        'node',
        'scripts/in-container.ts',
        ...args,
      ],
    };
  }
  if (!insidePinnedImage(where)) {
    throw new Error(
      `${MARKER} is set, but this is not inside the pinned Playwright image (${IMAGE}). ` +
        'Unset it and run the script again so it starts the image.',
    );
  }
  return { kind: 'run', command: [paths.cli, ...args.slice(1)] };
}

function main() {
  const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
  const repo = join(pkg, '..', '..');
  const { command } = plan(process.argv.slice(2), currentPlace(), {
    repo,
    pkg: relative(repo, pkg).split(sep).join('/'),
    cli: fileURLToPath(import.meta.resolve('@playwright/test/cli')),
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
  });
  const [program, ...rest] = command[0] === 'docker' ? command : [process.execPath, ...command];
  if (program === undefined) throw new Error('empty command');
  const result = spawnSync(program, rest, { stdio: 'inherit', cwd: pkg });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (import.meta.main) main();
