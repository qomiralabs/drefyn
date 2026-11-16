import { Resolver } from 'node:dns/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedConnectWith } from '../src/connect.ts';
import { guardedFetchWith } from '../src/fetch.ts';
import { policyFor } from '../src/policy.ts';
import type { Runtime } from '../src/runtime.ts';
import { type DnsFixture, startDnsFixture } from './support/dns-server.ts';
import { type Dial, type Fixture, fakeRuntime, httpFixture } from './support/runtime.ts';

// A real DNS server on loopback that answers like a rebinding attacker: public first, then
// private, with a TTL of 0. The guard must resolve once and dial only what it checked.
const PUBLIC = '93.184.215.14';
let dns: DnsFixture;
let trap: Fixture;

beforeAll(async () => {
  dns = await startDnsFixture({
    'rebind.test': [PUBLIC, '127.0.0.1'],
    'rebind-metadata.test': [PUBLIC, '169.254.169.254', PUBLIC, '10.0.0.1'],
    'private-first.test': ['127.0.0.1', PUBLIC],
  });
  trap = await httpFixture((_req, res) => res.end('secret'));
});

afterAll(async () => {
  await dns.close();
  await trap.close();
});

// The fake runtime's dial log, with its lookup replaced by a real resolver pointed at the
// fixture server, so every answer comes over the wire from the attacker's DNS.
function rebindingRuntime(): { runtime: Runtime; dials: Dial[] } {
  const resolver = new Resolver({ timeout: 1_000, tries: 1 });
  resolver.setServers([`127.0.0.1:${String(dns.port)}`]);
  const fake = fakeRuntime({});
  return {
    dials: fake.dials,
    runtime: {
      ...fake.runtime,
      lookup: async (hostname) =>
        (await resolver.resolve4(hostname)).map((address) => ({ address, family: 4 })),
    },
  };
}

describe('DNS rebinding against a live DNS fixture', () => {
  it.each(['rebind.test', 'rebind-metadata.test', 'private-first.test'])(
    '%s never yields a connection to a private address over many requests',
    async (name) => {
      const { runtime, dials } = rebindingRuntime();
      const before = trap.requests.length;
      const outcomes = new Set<string>();
      for (let i = 0; i < 12; i += 1) {
        const result = await guardedFetchWith(
          runtime,
          `http://${name}:${String(trap.port)}/`,
          {},
          policyFor('monitor'),
        );
        outcomes.add(result.ok ? 'ok' : result.error.code);
      }
      // Every dial is the public answer; the private answers were refused before a dial.
      expect(dials.length).toBeGreaterThan(0);
      expect(dials.every((d) => d.address === PUBLIC)).toBe(true);
      expect(outcomes).toEqual(new Set(['ok', 'egress.address_denied']));
      // One query per request: the name is never looked up a second time to connect.
      expect(dns.queries.get(name)).toBeGreaterThanOrEqual(12);
      expect(trap.requests.length - before).toBe(dials.length);
    },
  );

  it('holds for raw connections too', async () => {
    const { runtime, dials } = rebindingRuntime();
    for (let i = 0; i < 6; i += 1) {
      const result = await guardedConnectWith(
        runtime,
        'rebind.test',
        trap.port,
        policyFor('monitor'),
      );
      if (result.ok) result.value.destroy();
    }
    expect(dials.length).toBe(3);
    expect(dials.every((d) => d.address === PUBLIC)).toBe(true);
  });
});
