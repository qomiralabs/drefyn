import { expect, it } from 'vitest';
import { PREVIEW_DIR, writePreview } from './preview.ts';

it('writes the preview files', async () => {
  const ids = await writePreview();
  expect(ids.length).toBeGreaterThan(0);
  console.info(`wrote ${ids.length} mails to ${PREVIEW_DIR}, open index.html`);
});
