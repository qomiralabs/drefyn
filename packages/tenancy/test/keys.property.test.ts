import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cacheKey, organizationId, projectId, surrogateKey, type TenantRef } from '../src/index.ts';
import { SCOPES, anyUuid, runs } from './support.ts';

const tenantIds = fc.tuple(anyUuid, anyUuid);
const scope = fc.constantFrom(...SCOPES);
const parts = fc.array(fc.string({ unit: 'binary', maxLength: 12 }), { maxLength: 5 });
const surrogateId = fc.option(fc.string({ unit: 'binary', maxLength: 24 }), { nil: undefined });

function ref([org, prj]: readonly [string, string]): TenantRef {
  return { organizationId: organizationId(org), projectId: projectId(prj) };
}

function prefixOf(key: string): string {
  return key.split(':').slice(0, 3).join(':');
}

function same(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// Half the pairs share the tenant, so the scope and parts branches are exercised too.
const pairOf = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<[T, T]> =>
  fc.oneof(
    fc.tuple(arb, arb),
    arb.map((x) => [x, x] as [T, T]),
  );

describe('cacheKey (property)', () => {
  it('gives equal keys for equal inputs', () => {
    fc.assert(
      fc.property(tenantIds, scope, parts, (ids, s, p) => {
        expect(cacheKey(ref(ids), s, ...p)).toBe(cacheKey(ref([...ids]), s, ...[...p]));
      }),
      runs,
    );
  });

  it('never gives equal keys for different tenants, projects, scopes or parts', () => {
    fc.assert(
      fc.property(
        pairOf(tenantIds),
        pairOf(scope),
        pairOf(parts),
        ([ta, tb], [sa, sb], [pa, pb]) => {
          const equalInput = same(ta, tb) && sa === sb && same(pa, pb);
          expect(cacheKey(ref(ta), sa, ...pa) === cacheKey(ref(tb), sb, ...pb)).toBe(equalInput);
        },
      ),
      runs,
    );
  });

  it('always carries the organization and the project, never another tenant prefix', () => {
    fc.assert(
      fc.property(tenantIds, tenantIds, scope, parts, (a, b, s, p) => {
        const key = cacheKey(ref(a), s, ...p);
        expect(prefixOf(key)).toBe(`v1:${a[0]}:${a[1]}`);
        if (!same(a, b)) expect(key.startsWith(`v1:${b[0]}:${b[1]}:`)).toBe(false);
      }),
      runs,
    );
  });
});

describe('surrogateKey (property)', () => {
  it('gives equal keys for equal inputs', () => {
    fc.assert(
      fc.property(tenantIds, scope, surrogateId, (ids, s, id) => {
        expect(surrogateKey(ref(ids), s, id)).toBe(surrogateKey(ref([...ids]), s, id));
      }),
      runs,
    );
  });

  it('never gives equal keys for different tenants, projects, scopes or ids', () => {
    fc.assert(
      fc.property(
        pairOf(tenantIds),
        pairOf(scope),
        pairOf(surrogateId),
        ([ta, tb], [sa, sb], [ia, ib]) => {
          const equalInput = same(ta, tb) && sa === sb && ia === ib;
          expect(surrogateKey(ref(ta), sa, ia) === surrogateKey(ref(tb), sb, ib)).toBe(equalInput);
        },
      ),
      runs,
    );
  });

  it('a purge for one tenant never matches another tenant by prefix', () => {
    fc.assert(
      fc.property(tenantIds, tenantIds, scope, surrogateId, (a, b, s, id) => {
        const key = surrogateKey(ref(a), s, id);
        expect(prefixOf(key)).toBe(`v1:${a[0]}:${a[1]}`);
        if (!same(a, b)) expect(key.startsWith(`v1:${b[0]}:${b[1]}:`)).toBe(false);
        expect(key).toMatch(/^[\x21-\x7e]+$/);
      }),
      runs,
    );
  });
});
