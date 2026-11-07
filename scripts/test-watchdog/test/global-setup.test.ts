import { writeSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import setup from '../src/global-setup.ts';

vi.mock('node:fs', () => ({ writeSync: vi.fn() }));

const real = Object.getOwnPropertyDescriptor(process, 'ppid');

afterEach(() => {
  vi.useRealTimers();
  if (real !== undefined) Object.defineProperty(process, 'ppid', real);
});

describe('the run watch', () => {
  it('starts once however many projects ask, and ends the run with its parent', () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    setup();
    setup();
    vi.advanceTimersByTime(5_000);
    expect(kill).not.toHaveBeenCalled();

    Object.defineProperty(process, 'ppid', { value: 1, configurable: true });
    vi.advanceTimersByTime(5_000);
    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGKILL');
    expect(writeSync).toHaveBeenCalledWith(2, expect.stringContaining('is gone'));
  });
});
