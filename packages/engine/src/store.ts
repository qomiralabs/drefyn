import { withTenant, type Database, type TenantSchema } from '@drefyn/db';
import type { TenantRef } from '@drefyn/tenancy';
import type { Transaction } from 'kysely';

export type EngineTx = Transaction<TenantSchema>;

export interface EngineStore {
  tenant<T>(
    tenant: TenantRef,
    work: (tx: EngineTx) => Promise<T>,
    options?: { readonly timeoutMs?: number },
  ): Promise<T>;
}

export const databaseStore = (db: Database): EngineStore => ({
  tenant: (tenant, work, options) => withTenant(db, tenant, work, options),
});
