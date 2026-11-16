import type { PublishedTableName } from './allow-lists.ts';
import type { Schema } from './schema.generated.ts';

// Only the tables on the published allow list, so a draft table is not even a name the
// reader's transaction can type.
export type PublishedView<S, T extends string> = { [K in keyof S & T]: S[K] };

export type PublishedSchema = PublishedView<Schema, PublishedTableName>;
