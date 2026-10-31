import type { PersonalTableName } from './allow-lists.ts';
import type { AppUsersTable } from './identity-columns.ts';
import type { Schema } from './schema.generated.ts';

// Tables with no project_id column, so organization scope cannot even name a project table.
export type OrganizationView<S> = {
  [K in keyof S as 'project_id' extends keyof S[K] ? never : K]: S[K];
};

// The identity and limiter tables belong to a person or to sign in, never to an
// organization. users stays, with drefyn_app's granted columns, for the members page.
export type OrganizationSchema = OrganizationView<Omit<Schema, PersonalTableName | 'users'>> & {
  users: AppUsersTable;
};

// Project work: the project and organization tables, never an identity or limiter table. A
// project path runs with an attacker supplied tenant, so it must not even name the API key
// throttle or anyone's address.
export type TenantSchema = Omit<Schema, PersonalTableName | 'users'>;
