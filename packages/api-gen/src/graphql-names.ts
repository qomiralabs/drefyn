// GraphQL names come from API names, which may hold underscores, so a plain join could make two
// different paths spell one name. Doubling every underscore inside a part and joining parts with
// one underscore keeps the mapping one to one, since no API name starts with an underscore.
const part = (name: string) => name.replaceAll('_', '__');

// Every helper type starts with an underscore and a fixed kind, a space no API name can reach,
// so a customer type can never take the name of a generated one.
export function helperName(kind: string, typeName: string, path: readonly string[] = []): string {
  return `_${kind}_${[typeName, ...path].map(part).join('_')}`;
}

export const SHARED = Object.freeze({
  decimal: '_Decimal',
  richText: '_RichText',
  filterValue: '_FilterValue',
  filterOp: '_FilterOp',
  where: '_Where',
});

export const rootField = (verb: 'get' | 'list' | 'create' | 'update' | 'delete', type: string) =>
  `${verb}_${type}`;
