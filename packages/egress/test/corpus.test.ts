import { describe, expect, it } from 'vitest';
import { guardedFetchWith } from '../src/fetch.ts';
import { policyFor } from '../src/policy.ts';
import type { EgressErrorCode, EgressPolicy } from '../src/types.ts';
import { fakeRuntime } from './support/runtime.ts';

// The SSRF corpus: every way of writing an internal target we know of, each with the code
// the guard must answer. None of them may reach a dial.
const NAMES: Record<string, readonly string[]> = {
  'private.example.com': ['10.0.0.5'],
  'metadata.example.com': ['169.254.169.254'],
  'mixed.example.com': ['93.184.215.14', '127.0.0.1'],
  'mapped.example.com': ['::ffff:127.0.0.1'],
  'nat64.example.com': ['64:ff9b::a9fe:a9fe'],
  'ula.example.com': ['fd00:ec2::254'],
  'empty.example.com': [],
  'junk.example.com': ['not-an-address'],
};

type Case = readonly [url: string, code: EgressErrorCode, addressClass?: string];

const CORPUS: readonly Case[] = [
  // Encodings of loopback and metadata that WHATWG URL folds to one address.
  ['http://127.0.0.1/', 'egress.address_denied', 'loopback'],
  ['http://0x7f.1/', 'egress.address_denied', 'loopback'],
  ['http://0x7f000001/', 'egress.address_denied', 'loopback'],
  ['http://2130706433/', 'egress.address_denied', 'loopback'],
  ['http://017700000001/', 'egress.address_denied', 'loopback'],
  ['http://0177.0.0.1/', 'egress.address_denied', 'loopback'],
  ['http://127.1/', 'egress.address_denied', 'loopback'],
  ['http://127.0.0.1./', 'egress.address_denied', 'loopback'],
  ['http://%31%32%37.0.0.1/', 'egress.address_denied', 'loopback'],
  ['http://１２７.0.0.1/', 'egress.address_denied', 'loopback'],
  ['http://0/', 'egress.address_denied', 'unspecified'],
  ['http://0.0.0.0/', 'egress.address_denied', 'unspecified'],
  ['http://169.254.169.254/latest/meta-data/', 'egress.address_denied', 'linkLocal'],
  ['http://2852039166/', 'egress.address_denied', 'linkLocal'],
  ['http://0xa9.0xfe.0xa9.0xfe/', 'egress.address_denied', 'linkLocal'],
  ['http://10.0.0.1/', 'egress.address_denied', 'private'],
  ['http://172.16.0.1/', 'egress.address_denied', 'private'],
  ['http://192.168.0.1/', 'egress.address_denied', 'private'],
  ['http://100.64.0.1/', 'egress.address_denied', 'carrierGradeNat'],
  ['http://192.0.0.170/', 'egress.address_denied', 'reserved'],
  ['http://198.18.0.1/', 'egress.address_denied', 'benchmarking'],
  ['http://224.0.0.1/', 'egress.address_denied', 'multicast'],
  ['http://255.255.255.255/', 'egress.address_denied', 'broadcast'],
  // IPv6 literals, mapped and embedded IPv4 forms.
  ['http://[::1]/', 'egress.address_denied', 'loopback'],
  ['http://[::]/', 'egress.address_denied', 'unspecified'],
  ['http://[::ffff:127.0.0.1]/', 'egress.address_denied', 'loopback'],
  ['http://[::ffff:169.254.169.254]/', 'egress.address_denied', 'linkLocal'],
  ['http://[0:0:0:0:0:ffff:a9fe:a9fe]/', 'egress.address_denied', 'linkLocal'],
  ['http://[::127.0.0.1]/', 'egress.address_denied', 'ipv4Compatible'],
  ['http://[64:ff9b::a9fe:a9fe]/', 'egress.address_denied', 'rfc6052'],
  ['http://[64:ff9b::808:808]/', 'egress.address_denied', 'rfc6052'],
  ['http://[2002:a9fe:a9fe::1]/', 'egress.address_denied', '6to4'],
  ['http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/', 'egress.address_denied', 'teredo'],
  ['http://[fd00:ec2::254]/', 'egress.address_denied', 'uniqueLocal'],
  ['http://[fdaa::3]/', 'egress.address_denied', 'uniqueLocal'],
  ['http://[fe80::1]/', 'egress.address_denied', 'linkLocal'],
  ['http://[fe80::1%25eth0]/', 'egress.url_invalid'],
  ['http://[ff02::1]/', 'egress.address_denied', 'multicast'],
  // Names refused before any DNS query.
  ['http://localhost/', 'egress.host_denied'],
  ['http://LOCALHOST./', 'egress.host_denied'],
  ['http://localhost.:80/', 'egress.host_denied'],
  ['http://api.localhost/', 'egress.host_denied'],
  ['http://metadata.google.internal/', 'egress.host_denied'],
  ['http://_api.internal/', 'egress.host_denied'],
  ['http://instance-data.ec2.internal./', 'egress.host_denied'],
  ['http://printer.local/', 'egress.host_denied'],
  ['http://router.home.arpa/', 'egress.host_denied'],
  ['http://intranet/', 'egress.host_denied'],
  ['http://intranet./', 'egress.host_denied'],
  ['http://metadata/', 'egress.host_denied'],
  // Names whose DNS answer is internal.
  ['http://private.example.com/', 'egress.address_denied', 'private'],
  ['http://metadata.example.com/', 'egress.address_denied', 'linkLocal'],
  ['http://mixed.example.com/', 'egress.address_denied', 'loopback'],
  ['http://mapped.example.com/', 'egress.address_denied', 'loopback'],
  ['http://nat64.example.com/', 'egress.address_denied', 'rfc6052'],
  ['http://ula.example.com/', 'egress.address_denied', 'uniqueLocal'],
  ['http://empty.example.com/', 'egress.dns_failed'],
  ['http://junk.example.com/', 'egress.dns_failed'],
  ['http://missing.example.com/', 'egress.dns_failed'],
  // Userinfo hides the real host from a reader; it is refused outright.
  ['http://good.example.com@169.254.169.254/', 'egress.url_invalid'],
  ['http://user:pass@93.184.215.14/', 'egress.url_invalid'],
  ['http://169.254.169.254\\@good.example.com/', 'egress.address_denied', 'linkLocal'],
  // Schemes and shapes.
  ['file:///etc/passwd', 'egress.scheme_denied'],
  ['gopher://93.184.215.14:6379/_INFO', 'egress.scheme_denied'],
  ['ftp://93.184.215.14/', 'egress.scheme_denied'],
  ['ws://93.184.215.14/', 'egress.scheme_denied'],
  ['data:text/plain,hi', 'egress.scheme_denied'],
  ['javascript:alert(1)', 'egress.scheme_denied'],
  ['not a url', 'egress.url_invalid'],
  ['', 'egress.url_invalid'],
  ['http://', 'egress.url_invalid'],
  ['http://[::1/', 'egress.url_invalid'],
  ['http://1.2.3.4.5/', 'egress.url_invalid'],
  ['http://256.0.0.1/', 'egress.url_invalid'],
  ['http://a..example.com/', 'egress.url_invalid'],
  [`http://${'a'.repeat(64)}.example.com/`, 'egress.url_invalid'],
  [`http://${'abcdefghi.'.repeat(26)}com/`, 'egress.url_invalid'],
];

describe('SSRF corpus with the monitor policy (any port, http allowed)', () => {
  const rows = CORPUS.map(([url, code, addressClass]) => ({ url, code, addressClass }));
  it.each(rows)('$url returns $code', async ({ url, code, addressClass }) => {
    const { runtime, dials } = fakeRuntime(NAMES);
    const result = await guardedFetchWith(runtime, url, {}, policyFor('monitor'));
    expect(result).toEqual({
      ok: false,
      error: { code, hop: 0, ...(addressClass === undefined ? {} : { addressClass }) },
    });
    expect(dials).toEqual([]);
  });

  it('never looks up a refused name', async () => {
    const { runtime, lookups } = fakeRuntime(NAMES);
    for (const [url, code] of CORPUS) {
      if (code === 'egress.host_denied') {
        await guardedFetchWith(runtime, url, {}, policyFor('monitor'));
      }
    }
    expect(lookups).toEqual([]);
  });
});

describe('scheme and port rules per purpose', () => {
  const runtime = () => fakeRuntime({ 'hooks.example.com': ['93.184.215.14'] });
  const cases: readonly [string, EgressPolicy, EgressErrorCode][] = [
    ['http://hooks.example.com/', policyFor('webhook'), 'egress.scheme_denied'],
    ['https://hooks.example.com:22/', policyFor('webhook'), 'egress.port_denied'],
    ['https://hooks.example.com:6379/', policyFor('feed'), 'egress.port_denied'],
    ['https://hooks.example.com:8443/', policyFor('feed'), 'egress.port_denied'],
    ['http://hooks.example.com/', policyFor('spec_fetch'), 'egress.scheme_denied'],
    ['http://hooks.example.com:443/', policyFor('feed'), 'egress.scheme_denied'],
  ];
  it.each(cases)('%s under %o returns %s', async (url, policy, code) => {
    const { runtime: rt, dials, lookups } = runtime();
    const result = await guardedFetchWith(rt, url, {}, policy);
    expect(result).toEqual({ ok: false, error: { code, hop: 0 } });
    expect(dials).toEqual([]);
    expect(lookups).toEqual([]);
  });
});

describe('private ranges a self hosted install or private probe allows', () => {
  it('still refuses every address outside the listed ranges', async () => {
    const { runtime, dials } = fakeRuntime(NAMES);
    const policy = policyFor('monitor', { allowPrivateCidrs: ['10.0.0.0/8'] });
    for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/', 'http://[fd00:ec2::254]/']) {
      const result = await guardedFetchWith(runtime, url, {}, policy);
      expect(result.ok, url).toBe(false);
    }
    expect(dials).toEqual([]);
  });
});
