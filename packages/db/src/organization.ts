import type { PersonalTableName } from './allow-lists.ts';
import type { AppUsersTable } from './identity-columns.ts';
import type { Schema } from './schema.generated.ts';

// Tables with no project_id column, so organization scope cannot even name a project table.
export type OrganizationView<S> = {
  [K in keyof S as 'project_id' extends keyof S[K] ? never : K]: S[K];
};

// The identity and limiter tables belong to a person or to sign in, never to an
// organization. users stays, with drefyn_app's granted columns, for the members page.
// eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type -- only users until the organization tables exist
export type OrganizationSchema = OrganizationView<Omit<Schema, PersonalTableName | 'users'>> & {
  users: AppUsersTable;
};
