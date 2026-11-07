import { poolSizeOf, withTenant, type Database, type TenantSchema } from '@drefyn/db';
import type { TenantRef } from '@drefyn/tenancy';
import type { Transaction } from 'kysely';
import type { EngineConfig } from './config.ts';
import { gateFor, gateLimits, type PoolGate } from './pool-gate.ts';

export type EngineTx = Transaction<TenantSchema>;

export interface EngineStore {
  // Lives here and not in the engine because a store is a pool, so an app that builds two engines
  // over one pool still has one count.
  readonly gate: PoolGate;
  tenant<T>(
    tenant: TenantRef,
    work: (tx: EngineTx) => Promise<T>,
    options?: { readonly timeoutMs?: number; readonly deadlineMs?: number },
  ): Promise<T>;
}

// Call at startup: this is where the ceiling meets the pool, and a bad pair stops the process.
export const databaseStore = (db: Database, config: EngineConfig): EngineStore => {
  const poolMax = poolSizeOf(db);
  return {
    gate: gateFor(db, gateLimits(config, poolMax), poolMax),
    tenant: (tenant, work, options) => withTenant(db, tenant, work, options),
  };
};
