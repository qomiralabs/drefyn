import type { AccessContext } from '@drefyn/auth';
import { z } from 'zod';
import { docsPagesOf, type DocsPage } from '../fixtures/pages.ts';
import { findProject } from '../fixtures/projects.ts';

const MAX_PAGES = 50;

const Update = z.strictObject({
  project: z.string().max(64),
  pages: z
    .array(z.strictObject({ id: z.string().max(64), archived: z.boolean() }))
    .min(1)
    .max(MAX_PAGES),
});

export type PagesAnswer =
  | { readonly ok: true; readonly pages: readonly DocsPage[] }
  | { readonly ok: false; readonly code: string };

const refuse = (code: string): PagesAnswer => ({ ok: false, code });

// Stands in for the docs API. It remembers nothing: placeholder data has no tenant to keep
// apart, and a shared list would let one e2e spec see another's archive. Reading is enough to
// reach it, since the permission model has no docs write yet and nothing here persists.
export function updatePages(access: AccessContext, input: unknown): PagesAnswer {
  const parsed = Update.safeParse(input);
  if (!parsed.success) return refuse('pages.input_invalid');
  const project = findProject(access, 'docs', parsed.data.project);
  const held = project === undefined ? undefined : docsPagesOf(project);
  if (held === undefined) return refuse('pages.not_found');
  const pages: DocsPage[] = [];
  for (const { id, archived } of parsed.data.pages) {
    const found = held.find((item) => item.id === id);
    if (found === undefined) return refuse('pages.unknown_page');
    pages.push({ ...found, archived });
  }
  return { ok: true, pages };
}
