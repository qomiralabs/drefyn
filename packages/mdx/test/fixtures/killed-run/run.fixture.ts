import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { it } from 'vitest';

const here = import.meta.dirname;
const workspace = resolve(here, '../../../../..');
const src = resolve(here, '../../../src');
const hosts = resolve(here, '../hosts');

const sealed = (flags: readonly string[], main: string) => [
  '--permission',
  `--allow-fs-read=${workspace}`,
  ...flags,
  main,
];

// One of everything a package's tests start, the way they start it.
const everything = [
  sealed(['--allow-worker'], resolve(src, 'host-main.ts')),
  sealed(['--allow-child-process'], resolve(src, 'supervisor-main.ts')),
  [resolve(hosts, 'fixture-host.ts'), 'host-probe'],
  [resolve(hosts, 'fixture-supervisor.ts'), 'host-probe'],
];

function listening(args: readonly string[]) {
  const child = spawn(process.execPath, args, {
    env: {
      DREFYN_PARSE_PORT: '0',
      DREFYN_PARSE_TOKEN_SHA256: process.env['FIXTURE_TOKEN_SHA256'],
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise<void>((done) => {
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('"port":')) done();
    });
  });
}

it('holds them all until the run is killed', { timeout: 300_000 }, async () => {
  await Promise.all(everything.map(listening));
  writeFileSync(process.env['FIXTURE_READY'] ?? '', 'ready');
  if (process.env['FIXTURE_SPIN'] === '1') {
    let turns = 0;
    while (Date.now() > 0) turns += 1;
    return turns;
  }
  await new Promise(() => undefined);
  return 0;
});
