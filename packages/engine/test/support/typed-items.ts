import { randomUUID } from 'node:crypto';
import type { FieldDef, FieldId, TypeId } from '@drefyn/schema';
import { type Built, key, ACTOR, newNode, seed, tree, type Seeded } from './fixture.ts';
import type { NodeId } from '../../src/index.ts';

export const fieldId = () => randomUUID() as FieldId;

const base = (id: FieldId, name: string) => ({
  id,
  apiName: name,
  label: name,
  required: false,
});

export const textField = (id: FieldId, name: string, over: Partial<FieldDef> = {}): FieldDef =>
  ({ ...base(id, name), kind: 'text', maxLength: 64, ...over }) as FieldDef;

export const numberField = (id: FieldId, name: string, over: Partial<FieldDef> = {}): FieldDef =>
  ({ ...base(id, name), kind: 'number', scale: 2, ...over }) as FieldDef;

export const booleanField = (id: FieldId, name: string, over: Partial<FieldDef> = {}): FieldDef =>
  ({ ...base(id, name), kind: 'boolean', ...over }) as FieldDef;

export const dateField = (id: FieldId, name: string, over: Partial<FieldDef> = {}): FieldDef =>
  ({ ...base(id, name), kind: 'date', withTime: true, ...over }) as FieldDef;

export const listField = (id: FieldId, name: string, over: Partial<FieldDef> = {}): FieldDef =>
  ({
    ...base(id, name),
    kind: 'list',
    maxItems: 32,
    of: { ...base(randomUUID() as FieldId, 'item'), kind: 'text', maxLength: 32 },
    ...over,
  }) as FieldDef;

export interface Changes {
  readonly deprecated?: readonly FieldId[];
  readonly retired?: readonly FieldId[];
  readonly confirmedRemovals?: readonly FieldId[];
}

export const schemaOf = (
  seeded: Seeded,
  fields: readonly FieldDef[],
  version = 1,
  changes: Changes = {},
) => ({
  typeId: seeded.typeId as TypeId,
  apiName: 'item',
  version,
  fields,
  deprecated: changes.deprecated ?? [],
  retired: changes.retired ?? [],
});

export const seedItems = (options: { readonly organization?: string } = {}): Promise<Seeded> =>
  seed({ family: 'studio_item', product: 'studio', ...options });

export async function declare(
  built: Built,
  seeded: Seeded,
  fields: readonly FieldDef[],
  version = 1,
  changes: Changes = {},
) {
  const done = await built.engine.declareSchema({
    tenant: seeded.tenant,
    typeId: seeded.typeId,
    schema: schemaOf(seeded, fields, version, changes),
    confirmedRemovals: changes.confirmedRemovals ?? [],
  });
  if (!done.ok) throw new Error(`declare refused: ${JSON.stringify(done.error)}`);
  return done.value;
}

export async function newItem(built: Built, seeded: Seeded): Promise<NodeId> {
  const made = await built.engine.createNode({
    tenant: seeded.tenant,
    family: 'studio_item',
    typeId: seeded.typeId,
  });
  if (!made.ok) throw new Error(`createNode refused: ${made.error.code}`);
  return made.value.nodeId;
}

export async function saveItem(
  built: Built,
  seeded: Seeded,
  nodeId: NodeId,
  expected: Parameters<Built['engine']['saveDraft']>[0]['expectedHeadVersionId'],
  fields?: Readonly<Record<string, unknown>>,
  text = 'A body.',
) {
  const done = await built.engine.saveDraft({
    tenant: seeded.tenant,
    nodeId,
    expectedHeadVersionId: expected,
    content: await tree(built.parse, seeded, text),
    origin: 'human',
    actor: ACTOR,
    idempotencyKey: key(),
    ...(fields === undefined ? {} : { fields }),
  });
  if (!done.ok) throw new Error(`saveDraft refused: ${JSON.stringify(done.error)}`);
  return done.value;
}

export const addItem = async (
  built: Built,
  seeded: Seeded,
  fields: Readonly<Record<string, unknown>>,
) => {
  const nodeId = await newItem(built, seeded);
  await saveItem(built, seeded, nodeId, null, fields);
  return nodeId;
};

export { newNode };
