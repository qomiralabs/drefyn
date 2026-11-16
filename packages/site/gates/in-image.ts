// Runs the gates inside the pinned Playwright image, as CI does, so a visual baseline made on
// a laptop matches the one CI compares against. The amd64 build runs under emulation on
// Apple Silicon. No network: the pages come from the local server inside the container.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE, IMAGE_MARKER } from './image.ts';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(pkg, '..', '..');
const passed = ['DREFYN_SITE_GATE_BREACH'].flatMap((name) =>
  process.env[name] === undefined ? [] : ['-e', `${name}=${process.env[name] ?? ''}`],
);

const result = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '--platform',
    'linux/amd64',
    '--ipc=host',
    '--network',
    'none',
    '--user',
    `${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`,
    '-e',
    'HOME=/tmp',
    '-e',
    `${IMAGE_MARKER}=${IMAGE}`,
    ...passed,
    '-v',
    `${repo}:/work`,
    '-w',
    '/work/packages/site',
    IMAGE,
    'node',
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
