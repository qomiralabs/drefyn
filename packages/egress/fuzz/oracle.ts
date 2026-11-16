import fc from 'fast-check';

// A second, numeric opinion on which addresses are public. It shares no code with the
// guard, so a parser slip on either side shows up as a disagreement.

const V4_DENIED: readonly (readonly [number, number])[] = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc0586300, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
  [0xf0000000, 4],
];

function inPrefix(value: number, base: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) >>> 0 === base;
}

export function v4IsPublic(value: number): boolean {
  return !V4_DENIED.some(([base, bits]) => inPrefix(value, base, bits));
}

export function dotted(value: number): string {
  return [24, 16, 8, 0].map((shift) => String((value >>> shift) & 0xff)).join('.');
}

// Groups are eight 16 bit numbers.
export function v6IsPublic(groups: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return v4IsPublic(((g6 << 16) >>> 0) + g7);
  }
  if (g0 < 0x2000 || g0 > 0x3fff) return false;
  if (g0 === 0x2001 && g1 < 0x200) return false; // IETF protocol assignments, Teredo
  if (g0 === 0x2001 && g1 === 0xdb8) return false;
  if (g0 === 0x2002) return false;
  if (g0 === 0x3fff && g1 < 0x1000) return false;
  return true;
}

const hex = (n: number) => n.toString(16);

/** Ways to write one IPv4 address that WHATWG URL folds to the dotted form. */
export function v4Spellings(value: number): string[] {
  const bytes = [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff);
  const [a = 0, b = 0, c = 0, d = 0] = bytes;
  return [
    dotted(value),
    String(value),
    `0x${hex(value)}`,
    `0${value.toString(8)}`,
    bytes.map((x) => `0x${hex(x)}`).join('.'),
    bytes.map((x) => `0${x.toString(8)}`).join('.'),
    `${String(a)}.${String((b << 16) + (c << 8) + d)}`,
    `${String(a)}.${String(b)}.${String((c << 8) + d)}`,
    `${dotted(value)}.`,
  ];
}

/** Ways to write one IPv6 address, all inside brackets for a URL. */
export function v6Spellings(groups: readonly number[]): string[] {
  const full = groups.map(hex).join(':');
  const padded = groups.map((g) => hex(g).padStart(4, '0')).join(':');
  const tail = groups[6] ?? 0;
  const last = groups[7] ?? 0;
  const mixed = `${groups.slice(0, 6).map(hex).join(':')}:${dotted(((tail << 16) >>> 0) + last)}`;
  return [full, padded.toUpperCase(), mixed];
}

export const v4Arbitrary = fc.oneof(
  fc.nat({ max: 0xffffffff }),
  // Edges of every denied range, where an off by one would hide.
  fc
    .constantFrom(...V4_DENIED)
    .chain(([base, bits]) =>
      fc.constantFrom(
        base,
        base - 1,
        (base + 2 ** (32 - bits)) >>> 0,
        (base + 2 ** (32 - bits) - 1) >>> 0,
      ),
    )
    .map((v) => v >>> 0),
);

const group = fc.nat({ max: 0xffff });
export const v6Arbitrary = fc.oneof(
  fc.array(group, { minLength: 8, maxLength: 8 }),
  fc
    .tuple(
      fc.constantFrom(
        0,
        0x64,
        0x100,
        0x2001,
        0x2002,
        0x2606,
        0x3fff,
        0x4000,
        0xfc00,
        0xfe80,
        0xfec0,
        0xff02,
      ),
      fc.constantFrom(0, 0xff9b, 0xdb8, 0x1ff, 0x200, 0xfff, 0x1000),
      fc.array(group, { minLength: 6, maxLength: 6 }),
    )
    .map(([g0, g1, rest]) => [g0, g1, ...rest]),
  v4Arbitrary.map((v) => [0, 0, 0, 0, 0, 0xffff, v >>> 16, v & 0xffff]),
);

const LABELS = [
  'localhost',
  'internal',
  'local',
  'home',
  'arpa',
  'example',
  'com',
  'a',
  'xn--',
  '_api',
  '0x7f',
  '127',
  '0',
];
const SEPARATORS = ['.', '..', '@', ':', '\\', '/', '%2e', '%00', '[', ']', '。', '．', '\t', ' '];

/** Host text built from pieces attackers mix: labels, numbers, separators and junk. */
export const hostArbitrary = fc
  .array(
    fc.oneof(
      fc.constantFrom(...LABELS),
      fc.constantFrom(...SEPARATORS),
      v4Arbitrary.chain((v) => fc.constantFrom(...v4Spellings(v))),
      v6Arbitrary.chain((g) => fc.constantFrom(...v6Spellings(g)).map((s) => `[${s}]`)),
      fc.string({ maxLength: 4 }),
    ),
    { minLength: 1, maxLength: 6 },
  )
  .map((parts) => parts.join(''));

export const urlArbitrary = fc
  .tuple(
    fc.constantFrom('http://', 'https://', 'HTTP://', 'http:', 'http:/', 'file://', 'ftp://', ''),
    fc.option(fc.constantFrom('user@', 'a:b@', 'x%40y@'), { nil: '' }),
    hostArbitrary,
    fc.option(fc.constantFrom(':80', ':443', ':0', ':65536', ':8443', ':', ':-1'), { nil: '' }),
    fc.constantFrom('/', '/a?b#c', '', '?x', '#y'),
  )
  .map((parts) => parts.join(''));
