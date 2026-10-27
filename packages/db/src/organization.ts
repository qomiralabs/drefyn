import type { Schema } from './schema.generated.ts';

// Tables with no project_id column, so organization scope cannot even name a project table.
export type OrganizationView<S> = {
  [K in keyof S as 'project_id' extends keyof S[K] ? never : K]: S[K];
};

// eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type -- empty until the first table exists
export type OrganizationSchema = OrganizationView<Schema>;
