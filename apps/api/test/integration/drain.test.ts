import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { pingDatabase, type Database } from '@drefyn/db';
import { beforeAll, expect, it } from 'vitest';
import { startApi, stopOnSignals } from '../../src/start.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';

const fresh = harness();
let h: Harness;

const SERVER = join(import.meta.dirname, '..', '..', 'server.ts');
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

describeWithStack('graceful stop against Postgres', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  it('finishes a request in flight on SIGTERM, refuses new ones, then closes the pools', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let pools: Database | undefined;
    const api = await startApi(
      { ...h.env, DREFYN_API_PORT: '0' },
      {
        logger: quiet,
        mount: (app, deps) => {
          pools = deps.db;
          app.get('/v1/slow', async (c) => {
            entered();
            await gate;
            return c.json({ finished: true });
          });
        },
      },
    );
    const signals = new EventEmitter();
    const exited = new Promise<number>((resolve) => {
      stopOnSignals(api, resolve, signals);
    });
    const base = `http://127.0.0.1:${String(api.port)}`;
    expect((await fetch(`${base}/readyz`)).status).toBe(200);

    const slow = fetch(`${base}/v1/slow`);
    await inside;
    signals.emit('SIGTERM');
    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
    release();
    expect(await (await slow).json()).toEqual({ finished: true });
    expect(await exited).toBe(0);
    if (pools === undefined) throw new Error('no pools');
    await expect(pingDatabase(pools)).rejects.toMatchObject({ code: 'DB_UNAVAILABLE' });
  });

  // The real process: the handler is wired to the signal, and the exit is clean.
  it('exits 0 on SIGTERM from the process entry point', async () => {
    const child = spawn(process.execPath, [SERVER], {
      env: { PATH: process.env['PATH'] ?? '', ...h.env, DREFYN_API_PORT: '0' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    const listening = new Promise<number>((resolve, reject) => {
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
        // Only whole lines: a chunk can end halfway through one.
        const line = stderr
          .split('\n')
          .slice(0, -1)
          .filter((l) => l.startsWith('{'))
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .find((l) => l['event'] === 'api.listening');
        if (line !== undefined) resolve(Number(line['port']));
      });
      child.on('close', () => {
        reject(new Error(`exited before listening: ${stderr}`));
      });
    });
    const port = await listening;
    expect((await fetch(`http://127.0.0.1:${String(port)}/readyz`)).status).toBe(200);
    const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
    child.kill('SIGTERM');
    expect(await closed).toBe(0);
    expect(stderr).toContain('"event":"api.stopped"');
  });
});
