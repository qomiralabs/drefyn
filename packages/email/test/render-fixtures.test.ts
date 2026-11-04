import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderMail } from '../src/index.ts';
import { FIXTURE_MESSAGES } from './fixtures/messages.ts';
import { ORIGIN } from './support.ts';

const dir = new URL('./fixtures/html/', import.meta.url);

// Screenshots show what a mail looks like; these pin every byte a client receives. Stored
// as .txt: packages may not carry .html, and nothing should reformat these bytes.
describe('pinned HTML', () => {
  it('has one fixture per message kind and no strays', () => {
    expect(readdirSync(dir).sort()).toEqual(
      FIXTURE_MESSAGES.map(([name]) => `${name}.html.txt`).sort(),
    );
    expect(FIXTURE_MESSAGES).toHaveLength(18);
  });

  it.each(FIXTURE_MESSAGES)('%s', async (name, message) => {
    const result = await renderMail(message, { linkOrigin: ORIGIN });
    if (!result.ok) throw new Error(`render refused: ${result.error.code}`);
    await expect(result.value.html).toMatchFileSnapshot(`./fixtures/html/${name}.html.txt`);
  });
});
