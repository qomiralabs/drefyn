import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writePreview } from '../tools/preview.ts';
import { PREVIEW_MESSAGES } from './fixtures/messages.ts';

const dir = mkdtempSync(join(tmpdir(), 'drefyn-email-preview-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('preview', () => {
  it('writes one html and one txt per fixture, and an index', async () => {
    const ids = await writePreview(dir);
    expect(ids).toEqual(PREVIEW_MESSAGES.map(([id]) => id));
    expect(readdirSync(dir).sort()).toEqual(
      [...ids.flatMap((id) => [`${id}.html`, `${id}.txt`]), 'index.html'].sort(),
    );
    const index = readFileSync(join(dir, 'index.html'), 'utf8');
    for (const id of ids) {
      expect(index).toContain(`href="${id}.html"`);
      expect(index).toContain(`href="${id}.txt"`);
    }
  });

  it('covers long and hostile names', () => {
    const ids = PREVIEW_MESSAGES.map(([id]) => id);
    expect(ids.filter((id) => id.startsWith('long.')).length).toBeGreaterThan(3);
    expect(ids.filter((id) => id.startsWith('hostile.')).length).toBeGreaterThan(3);
  });
});
