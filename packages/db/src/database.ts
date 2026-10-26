import type { Transaction } from 'kysely';
import type { OrganizationRef, TenantRef } from '@drefyn/tenancy';
import type { DatabaseConfig } from './config.ts';
import { notImplemented } from './not-implemented.ts';
import type { PublishedSchema } from './published.ts';
import type { Schema } from './schema.generated.ts';

export type TenantContext = TenantRef | OrganizationRef;

declare const appBrand: unique symbol;
declare const readerBrand: unique symbol;

// Opaque: holds the pool and never hands it out.
export interface Database {
  readonly [appBrand]: true;
}

export interface PublishedDatabase {
  readonly [readerBrand]: true;
}

export interface TransactionOptions {
  readonly timeoutMs?: number;
}

export function createDatabase(config: DatabaseConfig): Promise<Database> {
  return notImplemented(`createDatabase(${typeof config})`);
}

export function createPublishedDatabase(config: DatabaseConfig): Promise<PublishedDatabase> {
  return notImplemented(`createPublishedDatabase(${typeof config})`);
}

export function closeDatabase(db: Database | PublishedDatabase): Promise<void> {
  return notImplemented(`closeDatabase(${typeof db})`);
}

export function withTenant<T>(
  db: Database,
  ctx: TenantContext,
  work: (tx: Transaction<Schema>) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  return notImplemented(
    `withTenant(${typeof db}, ${typeof ctx}, ${typeof work}, ${typeof options})`,
  );
}

export function withPublishedReader<T>(
  db: PublishedDatabase,
  tenant: TenantRef,
  work: (tx: Transaction<PublishedSchema>) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  return notImplemented(
    `withPublishedReader(${typeof db}, ${typeof tenant}, ${typeof work}, ${typeof options})`,
  );
}
