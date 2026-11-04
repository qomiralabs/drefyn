// Checked by `pnpm typecheck`: the result types of the list cannot name a stored secret.
import type { IdOf } from '@drefyn/tenancy';
import { describe, expectTypeOf, it } from 'vitest';
import type { ApiKeyPage, ListApiKeysInput, ListedApiKey } from '../../src/index.ts';

describe('the API key list types', () => {
  it('have no hash or idempotency field on a listed key', () => {
    expectTypeOf<ListedApiKey>().not.toHaveProperty('secretHash');
    expectTypeOf<ListedApiKey>().not.toHaveProperty('secret_hash');
    expectTypeOf<ListedApiKey>().not.toHaveProperty('requestHash');
    expectTypeOf<ListedApiKey>().not.toHaveProperty('request_hash');
    expectTypeOf<ListedApiKey>().not.toHaveProperty('idempotencyKey');
    expectTypeOf<ListedApiKey>().not.toHaveProperty('idempotency_key');
    expectTypeOf<ListedApiKey>().not.toHaveProperty('secret');
  });

  it('say a listed key has a state from a closed list and a nullable creator', () => {
    expectTypeOf<ListedApiKey['state']>().toEqualTypeOf<'live' | 'expired' | 'revoked'>();
    expectTypeOf<ListedApiKey['creatorName']>().toEqualTypeOf<string | null>();
  });

  it('take former as a creator, beside membership ids', () => {
    expectTypeOf<NonNullable<ListApiKeysInput['createdBy']>[number]>().toEqualTypeOf<
      IdOf<'mem'> | 'former'
    >();
  });

  it('count a page by every product', () => {
    expectTypeOf<keyof ApiKeyPage['products']>().toEqualTypeOf<'docs' | 'studio' | 'status'>();
  });
});
