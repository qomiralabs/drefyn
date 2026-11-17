import { beforeEach, describe, expect, it, vi } from 'vitest';

const after = vi.fn<(task: () => Promise<void>) => void>();
vi.mock('next/server', () => ({ after }));

const { afterResponse } = await import('../src/server/later.ts');

beforeEach(() => {
  after.mockReset();
});

describe('afterResponse', () => {
  it('hands the task to after(), so the refusal goes out first', () => {
    const task = vi.fn(() => Promise.resolve());
    afterResponse(task);
    expect(after).toHaveBeenCalledExactlyOnceWith(task);
    expect(task).not.toHaveBeenCalled();
  });

  // A notice is never dropped because no request was there to hold it.
  it('runs the task at once outside a request', () => {
    after.mockImplementation(() => {
      throw new Error('after() was called outside a request scope');
    });
    const task = vi.fn(() => Promise.resolve());
    afterResponse(task);
    expect(task).toHaveBeenCalledOnce();
  });
});
