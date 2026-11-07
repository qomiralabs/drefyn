import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { descendants, stillRunning, sweep } from '../src/tree.ts';

const nap = ['-e', 'setInterval(() => undefined, 1000)'];

describe('the process tree', () => {
  it('finds children, and stops counting one that ended', async () => {
    const child = spawn(process.execPath, nap, { stdio: 'ignore' });
    await once(child, 'spawn');
    const tree = descendants(process.pid);
    expect(tree.map((row) => row.pid)).toContain(child.pid);
    const mine = tree.filter((row) => row.pid === child.pid);
    expect(stillRunning(mine)).toEqual(mine);

    sweep(mine);
    await once(child, 'exit');
    expect(stillRunning(mine)).toEqual([]);
  });

  it('does not count a reused pid as the process it saw', () => {
    expect(stillRunning([{ pid: process.pid, command: 'something else' }])).toEqual([]);
  });

  it('has no sweep trouble with a pid that is already gone', () => {
    expect(() => {
      sweep([{ pid: 2 ** 22 + 1, command: 'gone' }]);
    }).not.toThrow();
  });
});
