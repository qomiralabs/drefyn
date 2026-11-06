# `@drefyn/schema`

The content type definition behind Studio's editor, validation and generated APIs. It is
pure in the plain sense: nothing here logs, reads a clock or does I/O, and the same input
gives the same output. It uses zod to read untrusted input, so it is not listed in
`drefyn.pureEntries`, which allows no package at run time. Tenant IDs live on the rows
that store a schema, not inside the definition.

Schemas and filters come from customers. Treat both as untrusted. Errors carry fixed
codes, schema key paths and checked ids, and never repeat input text.

## Public API

```ts
const parsed = parseContentSchema(json); // shape and cost only
const result = validateSchema(next, prior, { knownTypes, confirmedRemovals });
const filter = checkFilter(schema, json, { itemCount, undeclaredScanMaxItems });
```

- `validateSchema(next, prior, options?)` returns a `SchemaDiff` or a `SchemaError` listing
  up to 50 issues. Pass `prior: null` for a new type, which must be version 1. It parses
  `next` itself, so it is safe on raw input.
- `knownTypes` is the project's other types. A type may always reference itself, and a
  missing list refuses every other target.
- `checkFilter` returns the parsed tree and the undeclared fields it must scan.
- `parseUnits` and `formatUnits` convert between decimal strings and integer units. Extra
  digits are refused, never rounded.
- `slotClassOf` says which filter row column a field can take. Assigning slots belongs to
  the engine.

## Evolving a schema

Adding an optional field and widening a rule are free. Everything else that could break a
consumer returns `schema.breaking_in_place`, with a `reason`:

| Change                                                                      | Reason                |
| --------------------------------------------------------------------------- | --------------------- |
| Field dropped, not deprecated first                                         | `removed`             |
| Deprecated field dropped, no confirmation                                   | `removal_unconfirmed` |
| Kind, scale, date precision, `many` or `localized` changed                  | `retyped`             |
| Field or type renamed                                                       | `renamed`             |
| Field moved to another parent                                               | `moved`               |
| Length, bounds, format, targets or media types tightened, or `unique` added | `narrowed`            |
| Required field added to an existing parent, or `required` turned on         | `required_added`      |
| `required` turned off on a field that is not deprecated                     | `required_dropped`    |
| `filterable` or `sortable` turned off                                       | `undeclared`          |
| Type id changed                                                             | `identity`            |
| Version is not the prior version plus one                                   | `version`             |

To retype a field, add a new one beside it and list the old id in `deprecated`. The old
field stays in `fields` and stays served. It leaves only when `confirmedRemovals` names
it, which comes from a person's action and never from the submitted schema.

A removed id goes into `retired`, and every later version carries that list unchanged, up
to 2,000 ids. An id never comes back, as its slot and stored content may still hold the
old meaning. A list element cannot be removed on its own, because it is the list's type:
add a new list field instead.

## Numbers

Number fields hold integer units with a `scale` from 0 to 6. `min`, `max` and filter
values are decimal strings that must fit a signed 64 bit integer in units. No float form
exists anywhere in this package.

## Text

`rich_text` is stored as the shared AST, so it takes no length and cannot be filtered.
`markdown` is a plain string field with a `maxLength`. Swapping one for the other is a
retype. Text lengths count UTF-8 bytes.

## Filters

A type declares up to 12 fields: 5 text, 5 integer, 2 time. A sortable field takes a slot
too, and a deprecated field keeps its slot.

| Kind                                                           | Slot    |
| -------------------------------------------------------------- | ------- |
| `text` up to 256 bytes, single `reference`                     | text    |
| `list` of up to 32 `text` items of up to 32 bytes, filter only | text    |
| `number`, `boolean`                                            | integer |
| `date`                                                         | time    |

Only top level fields can be declared or filtered. An undeclared filter works up to
20,000 items in a type and returns `filter.not_declared` above that. A count that is not
a whole number from 0 up also refuses the scan.

## Tests

`pnpm --filter @drefyn/schema test`. Property tests accept `FC_SEED`.
