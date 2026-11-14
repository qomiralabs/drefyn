import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeTxtResolver, type DnsBackend } from '../src/index.ts';

function dnsError(code: string): Error {
  return Object.assign(new Error(`queryTxt ${code}`), { code });
}

function backend(answer: () => Promise<string[][]>) {
  const made: { names: string[]; cancelled: number; options: unknown[] } = {
    names: [],
    cancelled: 0,
    options: [],
  };
  const factory = (options: { timeoutMs: number }): DnsBackend => {
    made.options.push(options);
    return {
      resolveTxt(name) {
        made.names.push(name);
        return answer();
      },
      cancel() {
        made.cancelled += 1;
      },
    };
  };
  return { factory, made };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createNodeTxtResolver', () => {
  it('joins the strings of each record, as a TXT record is split at 255 bytes', async () => {
    const long = 'x'.repeat(300);
    const { factory, made } = backend(() =>
      Promise.resolve([[long.slice(0, 255), long.slice(255)], ['v=spf1 -all']]),
    );
    const resolver = createNodeTxtResolver({ timeoutMs: 3000, backend: factory });
    expect(await resolver.lookupTxt('_drefyn-sso.acme.test')).toEqual({
      kind: 'answer',
      records: [long, 'v=spf1 -all'],
    });
    expect(made.names).toEqual(['_drefyn-sso.acme.test']);
    expect(made.options).toEqual([{ timeoutMs: 3000 }]);
  });

  it.each(['ENODATA', 'ENOTFOUND'])('answers no records for %s', async (code) => {
    const { factory } = backend(() => Promise.reject(dnsError(code)));
    const resolver = createNodeTxtResolver({ timeoutMs: 3000, backend: factory });
    expect(await resolver.lookupTxt('_drefyn-sso.acme.test')).toEqual({
      kind: 'answer',
      records: [],
    });
  });

  it.each(['ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED', 'EREFUSED', 'ECANCELLED', 'EBADRESP'])(
    'cannot say for %s',
    async (code) => {
      const { factory } = backend(() => Promise.reject(dnsError(code)));
      const resolver = createNodeTxtResolver({ timeoutMs: 3000, backend: factory });
      expect(await resolver.lookupTxt('_drefyn-sso.acme.test')).toEqual({ kind: 'unknown' });
    },
  );

  it('cannot say for an error with no code, or a code that is not a string', async () => {
    for (const thrown of [new Error('boom'), Object.assign(new Error('boom'), { code: 42 })]) {
      const { factory } = backend(() => Promise.reject(thrown));
      const resolver = createNodeTxtResolver({ timeoutMs: 3000, backend: factory });
      expect(await resolver.lookupTxt('_drefyn-sso.acme.test')).toEqual({ kind: 'unknown' });
    }
  });

  it('gives up at the timeout and cancels the query', async () => {
    vi.useFakeTimers();
    const { factory, made } = backend(() => new Promise<string[][]>(() => undefined));
    const resolver = createNodeTxtResolver({ timeoutMs: 3000, backend: factory });
    const pending = resolver.lookupTxt('_drefyn-sso.acme.test');
    await vi.advanceTimersByTimeAsync(2999);
    expect(made.cancelled).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ kind: 'unknown' });
    expect(made.cancelled).toBe(1);
  });

  it('keeps at most 64 records of at most 4096 characters', async () => {
    const records = Array.from({ length: 70 }, (_, i) => [`r${String(i)}`]);
    records[0] = ['y'.repeat(5000)];
    const { factory } = backend(() => Promise.resolve(records));
    const resolver = createNodeTxtResolver({ timeoutMs: 3000, backend: factory });
    const lookup = await resolver.lookupTxt('_drefyn-sso.acme.test');
    if (lookup.kind !== 'answer') throw new Error('expected an answer');
    expect(lookup.records).toHaveLength(63);
    expect(lookup.records[0]).toBe('r1');
  });

  it('refuses a timeout outside 1 ms to 60 s', () => {
    for (const timeoutMs of [0, -1, 60_001, 1.5, Number.NaN]) {
      expect(() => createNodeTxtResolver({ timeoutMs })).toThrow(/timeout/);
    }
  });

  it('builds a Node resolver by default without a network call', () => {
    const resolver = createNodeTxtResolver({ timeoutMs: 3000 });
    expect(typeof resolver.lookupTxt).toBe('function');
  });

  it('hands the servers to the backend', async () => {
    const { factory, made } = backend(() => Promise.resolve([]));
    const resolver = createNodeTxtResolver({
      timeoutMs: 3000,
      servers: ['192.0.2.53'],
      backend: factory,
    });
    await resolver.lookupTxt('_drefyn-sso.acme.test');
    expect(made.options).toEqual([{ timeoutMs: 3000, servers: ['192.0.2.53'] }]);
  });

  // Loopback only: the discard port has nothing listening, so the real Node resolver either
  // hears a refusal or runs out of time. Both say nothing about the record.
  it.each([1, 300])('asks a loopback resolver that never answers (%i ms)', async (timeoutMs) => {
    const resolver = createNodeTxtResolver({ timeoutMs, servers: ['127.0.0.1:9'] });
    expect(await resolver.lookupTxt('_drefyn-sso.acme.test')).toEqual({ kind: 'unknown' });
  });
});
