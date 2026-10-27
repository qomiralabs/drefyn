import { describe, expect, it } from 'vitest';
import {
  VECTOR_VERSION_FLOOR,
  compareVersions,
  meetsVersionFloor,
  parseVersion,
} from '../src/version.ts';

describe('parseVersion', () => {
  it.each([
    ['0.8.2', [0, 8, 2]],
    ['0.8.7', [0, 8, 7]],
    ['0.8.10', [0, 8, 10]],
    ['0.10.0', [0, 10, 0]],
    ['1.0.0', [1, 0, 0]],
    ['12.345.6789', [12, 345, 6789]],
  ])('reads %s as numbers', (value, parts) => {
    expect(parseVersion(value)).toEqual(parts);
  });

  // An extversion we cannot read must not be waved through as new enough.
  it.each([
    '',
    '0.8',
    '0.8.2.1',
    '0.8.2-dev',
    '0.8.2rc1',
    'v0.8.2',
    ' 0.8.2',
    '0.8.2 ',
    '0..2',
    '0.8.',
    '.8.2',
    '0.8.x',
    '0.08.2',
    '00.8.2',
    '0.8.02',
    '-0.8.2',
    '0.8.-2',
    '0.8.2\n',
    '٠.8.2',
    '0.8.99999999999999999999',
  ])('rejects %j', (value) => {
    expect(parseVersion(value)).toBeUndefined();
  });
});

describe('compareVersions', () => {
  it('compares numerically, not as strings', () => {
    expect(compareVersions('0.8.10', '0.8.9')).toBe(1);
    expect(compareVersions('0.8.9', '0.8.10')).toBe(-1);
    expect(compareVersions('0.10.0', '0.8.2')).toBe(1);
    expect(compareVersions('0.8.2', '0.10.0')).toBe(-1);
    expect(compareVersions('0.9.0', '0.8.99')).toBe(1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
  });

  it('treats equal versions as equal', () => {
    expect(compareVersions('0.8.2', '0.8.2')).toBe(0);
    expect(compareVersions('0.8.7', '0.8.7')).toBe(0);
  });

  it('orders by major, then minor, then patch', () => {
    expect(compareVersions('0.8.7', '0.8.2')).toBe(1);
    expect(compareVersions('0.8.1', '0.8.2')).toBe(-1);
    expect(compareVersions('0.7.9', '0.8.0')).toBe(-1);
  });

  it('throws on a malformed side instead of guessing', () => {
    expect(() => compareVersions('0.8', '0.8.2')).toThrow(/0\.8/);
    expect(() => compareVersions('0.8.2', 'banana')).toThrow(/banana/);
  });
});

describe('meetsVersionFloor', () => {
  it('uses 0.8.2, the pgvector managed Postgres ships', () => {
    expect(VECTOR_VERSION_FLOOR).toBe('0.8.2');
  });

  it('accepts exactly the floor', () => {
    expect(meetsVersionFloor('0.8.2')).toBe(true);
  });

  it.each(['0.8.3', '0.8.7', '0.8.10', '0.9.0', '0.10.0', '1.0.0'])('accepts %s', (v) => {
    expect(meetsVersionFloor(v)).toBe(true);
  });

  it.each(['0.8.1', '0.8.0', '0.7.4', '0.5.1'])('refuses %s', (v) => {
    expect(meetsVersionFloor(v)).toBe(false);
  });

  it.each(['', '0.8', '0.8.2-dev', 'latest'])('refuses unreadable %j', (v) => {
    expect(meetsVersionFloor(v)).toBe(false);
  });

  it('takes another floor when given one', () => {
    expect(meetsVersionFloor('0.8.7', '0.8.7')).toBe(true);
    expect(meetsVersionFloor('0.8.6', '0.8.7')).toBe(false);
  });
});
