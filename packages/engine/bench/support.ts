import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ContentSchema, FieldDef, FieldId, TypeId } from '@drefyn/schema';
import { assignSlots, type SlotMap } from '../src/filter-slots.ts';

const corpus = join(import.meta.dirname, '..', '..', 'mdx', 'test', 'fixtures', 'corpus');

// Real pages, smallest first, joined until they pass the size. md, since mdx pages share import
// names, and a repeated binding is a syntax error in one file.
export function pageOf(bytes: number): string {
  const pages = readdirSync(corpus)
    .filter((file) => file.endsWith('.md.txt'))
    .sort()
    .map((file) => readFileSync(join(corpus, file), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, ''))
    .sort((a, b) => a.length - b.length);
  let page = '';
  for (const text of pages) {
    page += `${text}\n\n`;
    if (Buffer.byteLength(page) >= bytes) return page;
  }
  throw new Error('the corpus is too small for this page');
}

export function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

export const rounded = (value: number): number => Number(value.toFixed(1));

const field = (name: string, over: object): FieldDef =>
  ({
    id: randomUUID() as FieldId,
    apiName: name,
    label: name,
    required: false,
    filterable: true,
    sortable: true,
    ...over,
  }) as FieldDef;

const TEXT = { kind: 'text', maxLength: 64 };
const NUMBER = { kind: 'number', scale: 0 };
const WHEN = { kind: 'date', withTime: true };

// Every slot of a type filled: the widest row a declared list reads, four texts and a list inside
// the five text slots.
export const benchFields = () => ({
  category: field('category', TEXT),
  status: field('status', TEXT),
  segment: field('segment', TEXT),
  title: field('title', TEXT),
  tags: field('tags', {
    kind: 'list',
    sortable: false,
    maxItems: 32,
    of: { id: randomUUID(), apiName: 'tag', label: 'tag', required: false, ...TEXT, maxLength: 32 },
  }),
  score: field('score', NUMBER),
  rank: field('rank', NUMBER),
  size: field('size', NUMBER),
  weight: field('weight', NUMBER),
  region: field('region', NUMBER),
  created: field('created', WHEN),
  updated: field('updated', WHEN),
});

export type BenchFields = ReturnType<typeof benchFields>;

export function benchSchema(
  typeId: string,
  fields: BenchFields,
): { readonly schema: ContentSchema; readonly slots: SlotMap } {
  const schema: ContentSchema = {
    typeId: typeId as TypeId,
    apiName: 'item',
    version: 1,
    fields: Object.values(fields),
    deprecated: [],
    retired: [],
  };
  const plan = assignSlots(schema, {}, false);
  if (!plan.ok) throw new Error(plan.error.code);
  return { schema, slots: plan.value.slots };
}

// Values for one save. Every slot differs from the last round, the costly case.
export const benchValues = (fields: BenchFields, round: number) => {
  const text = `value ${String(round)}`;
  const at = new Date(Date.UTC(2026, 0, 1) + round * 1000).toISOString();
  return {
    [fields.category.id]: text,
    [fields.status.id]: text,
    [fields.segment.id]: text,
    [fields.title.id]: text,
    [fields.tags.id]: [text],
    [fields.score.id]: String(round),
    [fields.rank.id]: String(round),
    [fields.size.id]: String(round),
    [fields.weight.id]: String(round),
    [fields.region.id]: String(round),
    [fields.created.id]: at,
    [fields.updated.id]: at,
  };
};
