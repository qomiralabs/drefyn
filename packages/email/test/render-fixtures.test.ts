import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderMail } from '../src/index.ts';
import { FIXTURE_MESSAGES } from './fixtures/messages.ts';
import { ORIGIN } from './support.ts';

// The fixtures are what @react-email/render 2.1.1 produced for these messages. Its
// streaming render added these React markers and nothing else, so with them removed the
// fixture must match the current output byte for byte.
const STREAM_MARKERS = ['<!--$-->', '<!--/$-->', '<!--html-->', '<!--head-->', '<!--body-->'];

const dir = new URL('./fixtures/html/', import.meta.url);
// Stored as .txt: packages may not carry .html, and nothing should reformat these bytes.
const fixture = (name: string) => readFileSync(new URL(`${name}.html.txt`, dir), 'utf8');

function withoutMarkers(html: string): string {
  let out = html;
  for (const marker of STREAM_MARKERS) {
    // Exactly one of each, so a fixture that grew other comments cannot pass by accident.
    expect(out.split(marker).length - 1, marker).toBe(1);
    out = out.replace(marker, '');
  }
  return out;
}

describe('html matches the previous renderer', () => {
  it('has one fixture per message kind and no strays', () => {
    expect(readdirSync(dir).sort()).toEqual(
      FIXTURE_MESSAGES.map(([name]) => `${name}.html.txt`).sort(),
    );
    expect(FIXTURE_MESSAGES).toHaveLength(18);
  });

  it.each(FIXTURE_MESSAGES)('%s', async (name, message) => {
    const result = await renderMail(message, { linkOrigin: ORIGIN });
    if (!result.ok) throw new Error(`render refused: ${result.error.code}`);
    expect(result.value.html).toBe(withoutMarkers(fixture(name)));
    expect(result.value.html).not.toContain('<!--');
  });
});
