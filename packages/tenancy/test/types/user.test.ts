// Checked by `pnpm typecheck`: each @ts-expect-error fails the build if the line below it
// starts to compile. The function body never runs; vitest only confirms the file loads.
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  idOf,
  organizationId,
  parsePublicId,
  projectId,
  toPublicId,
  userId,
  type IdOf,
  type OrganizationId,
  type OrganizationRef,
  type ProjectId,
  type TenantRef,
  type UserId,
  type UserRef,
} from '../../src/index.ts';

declare const org: OrganizationId;
declare const prj: ProjectId;
declare const usr: UserId;
declare const ses: IdOf<'ses'>;
declare const inv: IdOf<'inv'>;
declare const userRef: UserRef;
declare const orgRef: OrganizationRef;
declare const tenant: TenantRef;
declare const plain: string;

function takesUserId(id: UserId): UserId {
  return id;
}
function takesOrganizationId(id: OrganizationId): OrganizationId {
  return id;
}
function takesProjectId(id: ProjectId): ProjectId {
  return id;
}
function takesUserRef(ref: UserRef): UserRef {
  return ref;
}
function takesOrganizationRef(ref: OrganizationRef): OrganizationRef {
  return ref;
}
function takesSessionId(id: IdOf<'ses'>): IdOf<'ses'> {
  return id;
}
function takesInvitationId(id: IdOf<'inv'>): IdOf<'inv'> {
  return id;
}

function compileOnly(): void {
  // A user id never stands in for a tenant id, nor the reverse.
  // @ts-expect-error a UserId is not an OrganizationId
  takesOrganizationId(usr);
  // @ts-expect-error a UserId is not a ProjectId
  takesProjectId(usr);
  // @ts-expect-error an OrganizationId is not a UserId
  takesUserId(org);
  // @ts-expect-error a ProjectId is not a UserId
  takesUserId(prj);
  // @ts-expect-error a plain string is not a UserId
  takesUserId(plain);
  // @ts-expect-error a string literal is not a UserId
  takesUserId('01928c3e-7a9b-7c3d-8e4f-0123456789ab');
  // @ts-expect-error userId() does not give an OrganizationId
  takesOrganizationId(userId(plain));
  // @ts-expect-error organizationId() does not give a UserId
  takesUserId(organizationId(plain));
  // @ts-expect-error a user id cannot be encoded as an organization
  toPublicId('org', usr);
  // @ts-expect-error parsing an organization id does not give a UserId
  takesUserId(parsePublicId('org', plain));
  // @ts-expect-error a session id is not a UserId
  takesUserId(ses);

  // Session and invitation ids are their own kinds.
  // @ts-expect-error a session id is not an invitation id
  takesInvitationId(ses);
  // @ts-expect-error an invitation id is not a session id
  takesSessionId(inv);
  // @ts-expect-error a plain string is not a session id
  takesSessionId(plain);
  // @ts-expect-error an invitation id is not an OrganizationId
  takesOrganizationId(inv);

  // Refs do not cross.
  // @ts-expect-error a UserRef has no organization
  takesOrganizationRef(userRef);
  // @ts-expect-error an OrganizationRef has no user
  takesUserRef(orgRef);
  // @ts-expect-error a TenantRef has no user
  takesUserRef(tenant);
  // @ts-expect-error an organization id in the user slot
  takesUserRef({ userId: org });
  // @ts-expect-error a plain string in the user slot
  takesUserRef({ userId: plain });
  // @ts-expect-error refs are read only
  userRef.userId = usr;

  // What must keep compiling.
  takesUserId(userId(plain));
  takesUserId(idOf('usr', plain));
  takesUserId(parsePublicId('usr', plain));
  takesUserRef({ userId: usr });
  takesSessionId(parsePublicId('ses', plain));
  takesInvitationId(idOf('inv', plain));
  toPublicId('usr', usr);
  toPublicId('ses', ses);
  toPublicId('inv', inv);
}

describe('user and session type tests', () => {
  it('compile under pnpm typecheck', () => {
    expect(typeof compileOnly).toBe('function');
  });

  it('pin the exported shapes', () => {
    expectTypeOf<UserId>().toEqualTypeOf<IdOf<'usr'>>();
    expectTypeOf<UserId>().toExtend<string>();
    expectTypeOf<string>().not.toExtend<UserId>();
    expectTypeOf<UserId>().not.toExtend<OrganizationId>();
    expectTypeOf<OrganizationId>().not.toExtend<UserId>();
    expectTypeOf<UserId>().not.toExtend<ProjectId>();
    expectTypeOf<ProjectId>().not.toExtend<UserId>();
    expectTypeOf<IdOf<'ses'>>().not.toExtend<IdOf<'inv'>>();
    expectTypeOf<UserRef>().toEqualTypeOf<{ readonly userId: UserId }>();
    expectTypeOf<UserRef>().not.toExtend<OrganizationRef>();
    expectTypeOf<OrganizationRef>().not.toExtend<UserRef>();
    expectTypeOf(userId).returns.toEqualTypeOf<UserId>();
    expectTypeOf(userId).parameters.toEqualTypeOf<[string]>();
  });
});
