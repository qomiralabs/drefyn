import type { AuthEvent } from '@drefyn/auth';
import { idOf } from '@drefyn/tenancy';
import { describe, expect, it, vi } from 'vitest';
import { logEventSink } from '../src/server/auth-events.ts';

const ORG = idOf('org', '01890a5d-ac96-774b-bcce-b302099a8080');
const CONNECTION = idOf('ssc', '01890a5d-ac96-774b-bcce-b302099a8081');
const DOMAIN = idOf('ssd', '01890a5d-ac96-774b-bcce-b302099a8082');
const USER = idOf('usr', '01890a5d-ac96-774b-bcce-b302099a8083');
const AT = new Date('2026-11-16T09:00:00.000Z');
// Built, not written out, so the secret scan does not read a test value as a key.
const DOMAIN_KEY = 'ab'.repeat(8);

function lines() {
  const seen: Record<string, unknown>[] = [];
  vi.spyOn(console, 'info').mockImplementation((text: string) =>
    seen.push(JSON.parse(text) as Record<string, unknown>),
  );
  return seen;
}

const event = (over: Partial<AuthEvent> = {}): AuthEvent => ({
  type: 'sso.domain_verified',
  organizationId: ORG,
  connectionId: CONNECTION,
  domainId: DOMAIN,
  domainKey: DOMAIN_KEY,
  actorUserId: USER,
  at: AT,
  ...over,
});

describe('logEventSink', () => {
  it('writes one line with the ids, the domain key and the database time', async () => {
    const seen = lines();
    await logEventSink.record(event());
    expect(seen).toEqual([
      {
        level: 'info',
        event: 'dashboard.auth_event',
        service: 'dashboard',
        type: 'sso.domain_verified',
        organizationId: ORG,
        connectionId: CONNECTION,
        domainId: DOMAIN,
        domainKey: DOMAIN_KEY,
        actorUserId: USER,
        at: '2026-11-16T09:00:00.000Z',
      },
    ]);
  });

  it('leaves the actor out of a change the daily recheck made', async () => {
    const seen = lines();
    await logEventSink.record(event({ type: 'sso.domain_unverified', actorUserId: null }));
    expect(seen[0]).not.toHaveProperty('actorUserId');
    expect(seen[0]).toMatchObject({ type: 'sso.domain_unverified', organizationId: ORG });
  });

  // Only the fields the event type names reach the log, so a field added to an event later
  // has to be added here on purpose.
  it('drops any field it does not know', async () => {
    const seen = lines();
    const extra = { ...event(), domain: 'login.acme.example', email: 'ada@acme.example' };
    await logEventSink.record(extra);
    expect(JSON.stringify(seen)).not.toMatch(/acme/);
  });
});
