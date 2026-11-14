import type { IdOf, OrganizationId, UserId } from '@drefyn/tenancy';

export type SsoConnectionId = IdOf<'ssc'>;
export type SsoDomainId = IdOf<'ssd'>;

// The audit record of a change to who an organization trusts. Ids and an HMAC only: the
// domain itself is never in an event, since events outlive the claim and travel to other
// stores.
export interface SsoDomainEvent {
  readonly type: 'sso.domain_claimed' | 'sso.domain_verified' | 'sso.domain_unverified';
  readonly organizationId: OrganizationId;
  readonly connectionId: SsoConnectionId;
  readonly domainId: SsoDomainId;
  // The same key the logs carry, so an operator can tie the two together.
  readonly domainKey: string;
  // null when the daily recheck made the change.
  readonly actorUserId: UserId | null;
  // Database time of the change.
  readonly at: Date;
}

export type AuthEvent = SsoDomainEvent;

export interface AuthEventSink {
  // Called after the change commits. A failure is logged and never undoes the change.
  record(event: AuthEvent): Promise<void>;
}
