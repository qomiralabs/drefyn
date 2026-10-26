import { brotliDecompressSync } from 'node:zlib';

// Reads what the font tests need out of a WOFF2 file without a font toolkit: the character
// map, family name, version string, weight class and advance widths. Only tables that WOFF2
// stores untransformed are decoded, so their bytes sit as is in the decompressed stream.

const KNOWN_TAGS = [
  'cmap',
  'head',
  'hhea',
  'hmtx',
  'maxp',
  'name',
  'OS/2',
  'post',
  'cvt ',
  'fpgm',
  'glyf',
  'loca',
  'prep',
  'CFF ',
  'VORG',
  'EBDT',
  'EBLC',
  'gasp',
  'hdmx',
  'kern',
  'LTSH',
  'PCLT',
  'VDMX',
  'vhea',
  'vmtx',
  'BASE',
  'GDEF',
  'GPOS',
  'GSUB',
  'EBSC',
  'JSTF',
  'MATH',
  'CBDT',
  'CBLC',
  'COLR',
  'CPAL',
  'SVG ',
  'sbix',
  'acnt',
  'avar',
  'bdat',
  'bloc',
  'bsln',
  'cvar',
  'fdsc',
  'feat',
  'fmtx',
  'fvar',
  'gvar',
  'hsty',
  'just',
  'lcar',
  'mort',
  'morx',
  'opbd',
  'prop',
  'trak',
  'Zapf',
  'Silf',
  'Glat',
  'Gloc',
  'Feat',
  'Sill',
];

export interface FontInfo {
  family: string;
  version: string;
  codePoints: number[];
  weightClass: number;
  unitsPerEm: number;
  // Advance width in font units for each mapped code point.
  advances: Map<number, number>;
}

export function readWoff2(bytes: Buffer): FontInfo {
  if (bytes.toString('latin1', 0, 4) !== 'wOF2') throw new Error('not a WOFF2 file');
  const numTables = bytes.readUInt16BE(12);
  const compressedSize = bytes.readUInt32BE(20);
  let pos = 48;
  const readBase128 = () => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = bytes.readUInt8(pos++);
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error('bad UIntBase128');
  };
  const tables = new Map<string, { offset: number; length: number; transformed: boolean }>();
  let offset = 0;
  for (let i = 0; i < numTables; i++) {
    const flags = bytes.readUInt8(pos++);
    const index = flags & 0x3f;
    let tag: string;
    if (index === 63) {
      tag = bytes.toString('latin1', pos, pos + 4);
      pos += 4;
    } else {
      tag = KNOWN_TAGS[index] ?? `#${index}`;
    }
    const version = flags >> 6;
    const origLength = readBase128();
    const transformed = tag === 'glyf' || tag === 'loca' ? version !== 3 : version !== 0;
    const length = transformed ? readBase128() : origLength;
    tables.set(tag, { offset, length, transformed });
    offset += length;
  }
  const data = brotliDecompressSync(bytes.subarray(pos, pos + compressedSize));
  const table = (tag: string) => {
    const t = tables.get(tag);
    if (t === undefined) throw new Error(`no ${tag} table`);
    if (t.transformed) throw new Error(`${tag} is transformed; this reader only reads raw tables`);
    return data.subarray(t.offset, t.offset + t.length);
  };
  const names = table('name');
  const glyphs = readCmap(table('cmap'));
  const metrics = table('hmtx');
  const longMetrics = table('hhea').readUInt16BE(34);
  const advanceOf = (glyph: number) => metrics.readUInt16BE(Math.min(glyph, longMetrics - 1) * 4);
  return {
    family: readName(names, 1),
    version: readName(names, 5),
    codePoints: [...glyphs.keys()],
    weightClass: table('OS/2').readUInt16BE(4),
    unitsPerEm: table('head').readUInt16BE(18),
    advances: new Map([...glyphs].map(([c, g]) => [c, advanceOf(g)])),
  };
}

function readName(name: Buffer, id: number): string {
  const count = name.readUInt16BE(2);
  const strings = name.readUInt16BE(4);
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    const platform = name.readUInt16BE(r);
    const nameId = name.readUInt16BE(r + 6);
    if (platform !== 3 || nameId !== id) continue;
    const length = name.readUInt16BE(r + 8);
    const start = strings + name.readUInt16BE(r + 10);
    return name
      .subarray(start, start + length)
      .swap16()
      .toString('utf16le');
  }
  throw new Error(`no name ${id}`);
}

function readCmap(cmap: Buffer): Map<number, number> {
  const count = cmap.readUInt16BE(2);
  const subtables = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const r = 4 + i * 8;
    subtables.set(`${cmap.readUInt16BE(r)},${cmap.readUInt16BE(r + 2)}`, cmap.readUInt32BE(r + 4));
  }
  const full = subtables.get('3,10') ?? subtables.get('0,4');
  if (full !== undefined && cmap.readUInt16BE(full) === 12) return readFormat12(cmap, full);
  const bmp = subtables.get('3,1') ?? subtables.get('0,3');
  if (bmp === undefined) throw new Error('no Unicode cmap');
  return readFormat4(cmap, bmp);
}

function readFormat12(cmap: Buffer, at: number): Map<number, number> {
  const groups = cmap.readUInt32BE(at + 12);
  const out = new Map<number, number>();
  for (let g = 0; g < groups; g++) {
    const r = at + 16 + g * 12;
    const start = cmap.readUInt32BE(r);
    const first = cmap.readUInt32BE(r + 8);
    for (let c = start; c <= cmap.readUInt32BE(r + 4); c++) out.set(c, first + c - start);
  }
  return out;
}

function readFormat4(cmap: Buffer, at: number): Map<number, number> {
  const segments = cmap.readUInt16BE(at + 6) / 2;
  const ends = at + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  const out = new Map<number, number>();
  for (let s = 0; s < segments; s++) {
    const end = cmap.readUInt16BE(ends + s * 2);
    const start = cmap.readUInt16BE(starts + s * 2);
    const delta = cmap.readInt16BE(deltas + s * 2);
    const rangeOffset = cmap.readUInt16BE(rangeOffsets + s * 2);
    for (let c = start; c <= end && c !== 0xffff; c++) {
      let glyph: number;
      if (rangeOffset === 0) glyph = (c + delta) & 0xffff;
      else {
        const g = cmap.readUInt16BE(rangeOffsets + s * 2 + rangeOffset + (c - start) * 2);
        glyph = g === 0 ? 0 : (g + delta) & 0xffff;
      }
      if (glyph !== 0) out.set(c, glyph);
    }
  }
  return out;
}
