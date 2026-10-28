import type { AuthTableName, UserTableName } from './allow-lists.ts';
import type { Schema } from './schema.generated.ts';

// Only the named tables, so a table outside the list is not even a name the transaction can
// type.
export type NamedTables<S, T extends string> = { [K in keyof S & T]: S[K] };

// The identity tables drefyn_auth may touch, before anyone is signed in.
// eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type -- empty until the identity tables exist
export type AuthSchema = NamedTables<Schema, AuthTableName>;

// The signed in person's own rows and the organizations they belong to.
// eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type -- empty until the identity tables exist
export type UserSchema = NamedTables<Schema, UserTableName>;
