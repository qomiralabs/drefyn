import { describe, expect, it } from 'vitest';
import { classifyAddress, privateAllowList } from '../src/address.ts';

describe('classifyAddress', () => {
  it.each([
    ['8.8.8.8', 4, 'unicast'],
    ['1.1.1.1', 4, 'unicast'],
    ['93.184.215.14', 4, 'unicast'],
    ['2606:4700::1111', 6, 'unicast'],
    ['2001:4860:4860::8888', 6, 'unicast'],
    ['::ffff:8.8.8.8', 6, 'unicast'],
    ['::ffff:808:808', 6, 'unicast'],
  ] as const)('allows %s as public unicast', (address, family, addressClass) => {
    expect(classifyAddress(address)).toEqual({ family, addressClass });
  });

  it.each([
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['10.0.0.1', 'private'],
    ['100.64.0.1', 'carrierGradeNat'],
    ['100.127.255.255', 'carrierGradeNat'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.169.254', 'linkLocal'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.0.0.170', 'reserved'],
    ['192.0.2.1', 'documentation'],
    ['192.88.99.1', 'reserved'],
    ['192.168.1.1', 'private'],
    ['198.18.0.1', 'benchmarking'],
    ['198.19.255.255', 'benchmarking'],
    ['198.51.100.7', 'documentation'],
    ['203.0.113.9', 'documentation'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
  ] as const)('refuses IPv4 %s as %s', (address, addressClass) => {
    expect(classifyAddress(address)).toEqual({ family: 4, addressClass });
  });

  it.each([
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['::127.0.0.1', 'ipv4Compatible'],
    ['::a9fe:a9fe', 'ipv4Compatible'],
    // Mapped forms are judged by the IPv4 address inside.
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:169.254.169.254', 'linkLocal'],
    ['::ffff:a9fe:a9fe', 'linkLocal'],
    ['::ffff:10.1.2.3', 'private'],
    ['0:0:0:0:0:ffff:7f00:1', 'loopback'],
    ['64:ff9b::a9fe:a9fe', 'rfc6052'],
    ['64:ff9b::808:808', 'rfc6052'],
    ['64:ff9b:1::1', 'rfc8215'],
    ['100::1', 'discard'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'teredo'],
    ['2001:2::1', 'reserved'],
    ['2001:db8::1', 'documentation'],
    ['3fff::1', 'documentation'],
    ['2002:a9fe:a9fe::1', '6to4'],
    ['2002:808:808::1', '6to4'],
    ['fd00:ec2::254', 'uniqueLocal'],
    ['fdaa::3', 'uniqueLocal'],
    ['fc00::1', 'uniqueLocal'],
    ['fe80::1', 'linkLocal'],
    ['febf::1', 'linkLocal'],
    ['fec0::1', 'siteLocal'],
    ['ff02::1', 'multicast'],
    ['4000::1', 'reserved'],
    ['1::1', 'reserved'],
    ['2606:4700::1111%eth0', 'scoped'],
    ['fe80::1%lo0', 'scoped'],
  ] as const)('refuses IPv6 %s as %s', (address, addressClass) => {
    expect(classifyAddress(address)).toEqual({ family: 6, addressClass });
  });

  it.each(['', 'example.com', '0x7f.1', '2130706433', '127.1', '01.2.3.4', '[::1]', ' 8.8.8.8'])(
    'returns undefined for %j, which is not an address Node would connect to as given',
    (text) => {
      expect(classifyAddress(text)).toBeUndefined();
    },
  );
});

describe('privateAllowList', () => {
  it('matches addresses inside the listed ranges, IPv4 mapped forms included', () => {
    const list = privateAllowList(['10.0.0.0/8', 'fd00::/8', '192.168.1.5/32']);
    expect(list.has('10.9.8.7')).toBe(true);
    expect(list.has('::ffff:10.9.8.7')).toBe(true);
    expect(list.has('fd12::1')).toBe(true);
    expect(list.has('192.168.1.5')).toBe(true);
    expect(list.has('192.168.1.6')).toBe(false);
    expect(list.has('169.254.169.254')).toBe(false);
    expect(list.has('not an address')).toBe(false);
  });

  it.each([
    '10.0.0.0',
    '10.0.0.0/33',
    'fd00::/129',
    'nope/8',
    '10.0.0.0/-1',
    '10.0.0.0/8/8',
    '10.0.0.0/1.5',
  ])('refuses the malformed range %j', (cidr) => {
    expect(() => privateAllowList([cidr])).toThrow(TypeError);
  });
});
