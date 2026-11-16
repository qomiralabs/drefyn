import { crc32, deflateSync } from 'node:zlib';

// A PNG of seeded noise, stored without compression, so its size is width times height times
// three and a fixture can ask for exactly as many bytes as it needs to slow a page down.
export function noisePng(width: number, height: number, seed = 1): Buffer {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  let state = seed;
  for (let y = 0; y < height; y += 1) {
    raw[y * row] = 0;
    for (let x = 1; x < row; x += 1) {
      state = (state * 48_271) % 2_147_483_647;
      raw[y * row + x] = state & 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 0 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}
