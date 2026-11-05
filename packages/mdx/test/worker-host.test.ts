import { EventEmitter } from 'node:events';
import type { EventEmitter as Emitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serveJobs } from '../src/worker-host.ts';

const port = vi.hoisted(() => ({
  current: null as (Emitter & { postMessage: unknown }) | null,
}));
vi.mock('node:worker_threads', () => ({
  get parentPort() {
    return port.current;
  },
}));
// The seal has its own test, and it would turn off the network of this test process.
vi.mock('../src/seal-thread.ts', () => ({}));

const job = { source: 'page', dialect: 'md' as const, policy: {} as never };
const tick = () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

describe('serveJobs', () => {
  const postMessage = vi.fn();
  beforeEach(() => {
    postMessage.mockReset();
    port.current = Object.assign(new EventEmitter(), { postMessage });
  });

  it('says it is ready, then answers each job with its id', async () => {
    serveJobs(({ source }) => source.toUpperCase());
    expect(postMessage.mock.calls).toEqual([[{ ready: true }]]);
    port.current?.emit('message', { id: 7, job });
    await tick();
    expect(postMessage).toHaveBeenLastCalledWith({ id: 7, result: 'PAGE' });
  });

  it('waits for a job that answers later', async () => {
    serveJobs(() => Promise.resolve('later'));
    port.current?.emit('message', { id: 1, job });
    await tick();
    expect(postMessage).toHaveBeenLastCalledWith({ id: 1, result: 'later' });
  });

  it('refuses to run outside a thread', () => {
    port.current = null;
    expect(() => {
      serveJobs(() => undefined);
    }).toThrow('inside a worker thread');
  });
});
