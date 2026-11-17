import { describe, expect, it } from 'vitest';
import { checkPolicy, EGRESS_PURPOSES, policyFor } from '../src/policy.ts';
import type { EgressPolicy } from '../src/types.ts';

const KIB = 1024;
const MIB = 1024 * KIB;

describe('policyFor', () => {
  it('lists every purpose', () => {
    expect([...EGRESS_PURPOSES]).toEqual([
      'monitor',
      'webhook',
      'feed',
      'import',
      'spec_fetch',
      'try_it',
      'media_import',
      'model',
    ]);
  });

  it.each([
    ['monitor', ['https', 'http'], 'any', 5, 30_000, MIB],
    ['webhook', ['https'], [443, 8443], 0, 10_000, 64 * KIB],
    ['feed', ['https'], [443], 3, 10_000, MIB],
    ['import', ['https'], [443], 3, 30_000, 20 * MIB],
    ['spec_fetch', ['https'], [443], 3, 30_000, 20 * MIB],
    ['media_import', ['https'], [443], 3, 30_000, 20 * MIB],
    ['try_it', ['https', 'http'], 'any', 0, 15_000, 5 * MIB],
    ['model', ['https'], [443], 0, 120_000, 4 * MIB],
  ] as const)('gives %s its defaults', (purpose, schemes, ports, redirects, total, bytes) => {
    const policy = policyFor(purpose);
    expect(policy).toEqual({
      purpose,
      allowPrivate: false,
      schemes,
      ports,
      maxRedirects: redirects,
      connectTimeoutMs: 5_000,
      totalTimeoutMs: total,
      maxResponseBytes: bytes,
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(() => {
      checkPolicy(policy);
    }).not.toThrow();
  });

  it('lets a self hosted install send webhooks over plain http when it opts in', () => {
    expect(policyFor('webhook', { webhookAllowHttp: true }).schemes).toEqual(['https', 'http']);
    expect(policyFor('feed', { webhookAllowHttp: true }).schemes).toEqual(['https']);
  });

  it('lets a self hosted model on a listed private range use plain http and any port', () => {
    const local = policyFor('model', { modelLocal: true, allowPrivateCidrs: ['127.0.0.0/8'] });
    expect(local.schemes).toEqual(['https', 'http']);
    expect(local.ports).toBe('any');
    expect(local.allowPrivate).toEqual({ cidrs: ['127.0.0.0/8'] });
  });

  it('ignores modelLocal without a private range, and for every other purpose', () => {
    expect(policyFor('model', { modelLocal: true })).toEqual(policyFor('model'));
    expect(
      policyFor('feed', { modelLocal: true, allowPrivateCidrs: ['10.0.0.0/8'] }).schemes,
    ).toEqual(['https']);
    expect(
      policyFor('feed', { modelLocal: true, allowPrivateCidrs: ['10.0.0.0/8'] }).ports,
    ).toEqual([443]);
  });

  it('passes private ranges through only when they are given', () => {
    expect(policyFor('monitor', { allowPrivateCidrs: ['10.0.0.0/8'] }).allowPrivate).toEqual({
      cidrs: ['10.0.0.0/8'],
    });
    expect(policyFor('monitor', { allowPrivateCidrs: [] }).allowPrivate).toBe(false);
  });
});

describe('checkPolicy', () => {
  const base = policyFor('feed');
  const bad: [string, Partial<Record<keyof EgressPolicy, unknown>>][] = [
    ['an unknown purpose', { purpose: 'mail' }],
    ['no schemes', { schemes: [] }],
    ['a scheme other than http or https', { schemes: ['ftp'] }],
    ['an empty port list', { ports: [] }],
    ['port 0', { ports: [0] }],
    ['a port above 65535', { ports: [65536] }],
    ['a fractional port', { ports: [44.3] }],
    ['a port word other than any', { ports: 'all' }],
    ['more than 5 redirects', { maxRedirects: 6 }],
    ['negative redirects', { maxRedirects: -1 }],
    ['a zero connect timeout', { connectTimeoutMs: 0 }],
    ['an infinite total timeout', { totalTimeoutMs: Number.POSITIVE_INFINITY }],
    ['a fractional size cap', { maxResponseBytes: 1.5 }],
    ['allowPrivate true', { allowPrivate: true }],
    ['a malformed private range', { allowPrivate: { cidrs: ['10.0.0.0'] } }],
    ['an empty private range list', { allowPrivate: { cidrs: [] } }],
  ];
  it.each(bad)('refuses %s', (_name, change) => {
    expect(() => {
      checkPolicy({ ...base, ...change } as EgressPolicy);
    }).toThrow(TypeError);
  });
});
