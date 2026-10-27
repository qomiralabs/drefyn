import type { PublishedTableName } from './allow-lists.ts';
import type { Schema } from './schema.generated.ts';

// Only the tables on the published allow list, so a draft table is not even a name the
// reader's transaction can type.
export type PublishedView<S, T extends string> = { [K in keyof S & T]: S[K] };

// eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type -- empty until the first table is published
export type PublishedSchema = PublishedView<Schema, PublishedTableName>;
