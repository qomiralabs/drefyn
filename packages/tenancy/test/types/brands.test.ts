// Checked by `pnpm typecheck`: each @ts-expect-error fails the build if the line below it
// starts to compile. The function body never runs; vitest only confirms the file loads.
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  cacheKey,
  idOf,
  organizationId,
  parsePublicId,
  projectId,
  surrogateKey,
  toPublicId,
  type CacheKey,
  type CacheScope,
  type IdKind,
  type IdOf,
  type OrganizationId,
  type OrganizationRef,
  type ProjectId,
  type TenantRef,
} from '../../src/index.ts';

declare const org: OrganizationId;
declare const prj: ProjectId;
declare const usr: IdOf<'usr'>;
declare const orgRef: OrganizationRef;
declare const tenant: TenantRef;
declare const plain: string;

function takesOrganizationId(id: OrganizationId): OrganizationId {
  return id;
}
function takesProjectId(id: ProjectId): ProjectId {
  return id;
}
function takesTenant(ref: TenantRef): TenantRef {
  return ref;
}
function takesOrganizationRef(ref: OrganizationRef): OrganizationRef {
  return ref;
}
function takesCacheKey(key: CacheKey): CacheKey {
  return key;
}

function compileOnly(): void {
  // Plain strings never become branded values.
  // @ts-expect-error a plain string is not an OrganizationId
  takesOrganizationId(plain);
  // @ts-expect-error a string literal is not an OrganizationId
  takesOrganizationId('01928c3e-7a9b-7c3d-8e4f-0123456789ab');
  // @ts-expect-error a plain string is not a ProjectId
  takesProjectId(plain);
  // @ts-expect-error a plain string is not a CacheKey
  takesCacheKey(plain);
  // @ts-expect-error a template literal is not a CacheKey
  takesCacheKey(`v1:${org}:${prj}:page:x`);
  // @ts-expect-error a surrogate key is a header value, not a cache key
  takesCacheKey(surrogateKey(tenant, 'page'));
  // @ts-expect-error a plain string cannot be assigned to an OrganizationId variable
  const assigned: OrganizationId = plain;

  // ID kinds do not mix.
  // @ts-expect-error a ProjectId is not an OrganizationId
  takesOrganizationId(prj);
  // @ts-expect-error an OrganizationId is not a ProjectId
  takesProjectId(org);
  // @ts-expect-error a user id is not an OrganizationId
  takesOrganizationId(usr);
  // @ts-expect-error a project id cannot be encoded as an organization
  toPublicId('org', prj);
  // @ts-expect-error a plain string cannot be encoded
  toPublicId('org', plain);
  // @ts-expect-error parsing a project id does not give an OrganizationId
  takesOrganizationId(parsePublicId('prj', plain));
  // @ts-expect-error idOf for usr is not an OrganizationId
  takesOrganizationId(idOf('usr', plain));
  // @ts-expect-error unknown kinds are refused
  idOf('xyz', plain);
  // @ts-expect-error unknown kinds are refused
  parsePublicId('organization', plain);

  // Refs.
  // @ts-expect-error an OrganizationRef has no project, so it is not a TenantRef
  takesTenant(orgRef);
  // @ts-expect-error cache keys need a project
  cacheKey(orgRef, 'page');
  // @ts-expect-error surrogate keys need a project
  surrogateKey(orgRef, 'page');
  // @ts-expect-error a ref built from plain strings is not a TenantRef
  takesTenant({ organizationId: plain, projectId: plain });
  // @ts-expect-error ids swapped inside a ref
  takesTenant({ organizationId: prj, projectId: org });
  // @ts-expect-error refs are read only
  tenant.organizationId = org;
  // @ts-expect-error refs are read only
  tenant.projectId = prj;

  // Scopes and parts.
  // @ts-expect-error unknown scope
  cacheKey(tenant, 'pages');
  // @ts-expect-error parts are strings
  cacheKey(tenant, 'page', 42);
  // @ts-expect-error unknown scope
  surrogateKey(tenant, 'everything');

  // What must keep compiling.
  takesOrganizationRef(tenant);
  takesOrganizationId(organizationId(plain));
  takesProjectId(projectId(plain));
  takesOrganizationId(parsePublicId('org', plain));
  takesProjectId(idOf('prj', plain));
  takesCacheKey(cacheKey(tenant, 'page', 'a', 'b'));
  takesOrganizationId(assigned);
}

describe('type tests', () => {
  it('compile under pnpm typecheck', () => {
    expect(typeof compileOnly).toBe('function');
  });

  it('pin the exported shapes', () => {
    expectTypeOf<OrganizationId>().toExtend<string>();
    expectTypeOf<ProjectId>().toExtend<string>();
    expectTypeOf<CacheKey>().toExtend<string>();
    expectTypeOf<string>().not.toExtend<OrganizationId>();
    expectTypeOf<OrganizationId>().not.toEqualTypeOf<ProjectId>();
    expectTypeOf<IdOf<'org'>>().toEqualTypeOf<OrganizationId>();
    expectTypeOf<IdOf<'prj'>>().toEqualTypeOf<ProjectId>();
    expectTypeOf<IdOf<'usr'>>().not.toExtend<IdOf<'mem'>>();
    expectTypeOf<IdKind>().toEqualTypeOf<
      | 'org'
      | 'prj'
      | 'usr'
      | 'mem'
      | 'key'
      | 'nod'
      | 'ver'
      | 'ast'
      | 'cmp'
      | 'inc'
      | 'sub'
      | 'whk'
      | 'evt'
      | 'crd'
      | 'ses'
      | 'inv'
    >();
    expectTypeOf<CacheScope>().toEqualTypeOf<
      'page' | 'nav' | 'search' | 'retrieval' | 'render' | 'asset'
    >();
    expectTypeOf<TenantRef>().toExtend<OrganizationRef>();
    expectTypeOf<OrganizationRef>().not.toExtend<TenantRef>();
    expectTypeOf(parsePublicId<'org'>).returns.toEqualTypeOf<OrganizationId>();
    expectTypeOf(toPublicId<'prj'>).returns.toEqualTypeOf<string>();
    expectTypeOf(cacheKey).returns.toEqualTypeOf<CacheKey>();
  });
});
