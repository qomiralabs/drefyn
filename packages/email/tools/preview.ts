import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMail } from '../src/index.ts';
import { PREVIEW_MESSAGES } from '../test/fixtures/messages.ts';
import { ORIGIN } from '../test/support.ts';

export const PREVIEW_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.preview');

const entry = (id: string) =>
  `<li><a href="${id}.html">${id}</a> <a href="${id}.txt">text</a></li>`;

// Static files with no server, so a person, a screenshot run and axe all open the same bytes.
export async function writePreview(dir: string = PREVIEW_DIR): Promise<readonly string[]> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const ids: string[] = [];
  for (const [id, message] of PREVIEW_MESSAGES) {
    const result = await renderMail(message, { linkOrigin: ORIGIN });
    if (!result.ok) throw new Error(`${id}: ${result.error.code} ${result.error.field ?? ''}`);
    writeFileSync(join(dir, `${id}.html`), result.value.html);
    writeFileSync(join(dir, `${id}.txt`), result.value.text);
    ids.push(id);
  }
  writeFileSync(
    join(dir, 'index.html'),
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Drefyn mail preview</title><ul>${ids.map(entry).join('')}</ul></html>\n`,
  );
  return ids;
}
