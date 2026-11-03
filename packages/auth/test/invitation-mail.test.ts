import type { AuthDatabase, Database } from '@drefyn/db';
import { idOf } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import { grantAccess } from '../src/access.ts';
import { createInvitations, type InvitationSend } from '../src/index.ts';
import { INVITER_FALLBACK, plainInviterName } from '../src/invitations.ts';
import { scriptedStore, type Responder } from './scripted-store.ts';
import {
  AUTHENTICATED_AT,
  SESSION,
  USER,
  capturingLogger,
  config,
  noopLimiter,
} from './session-fixtures.ts';

const ORG = idOf('org', '01890a5d-ac96-774b-bcce-b302099a8070');
const INV = idOf('inv', '01890a5d-ac96-774b-bcce-b302099a8072');

// Only the statements a send needs; every other read answers empty.
function respond(organizationName: string, displayName: string | null): Responder {
  return (s) => {
    if (s.sql.includes('count(*)')) return [{ used: 1, plan_tier: 'self_hosted' }];
    if (s.sql.startsWith('select') && s.sql.includes('"organizations"')) {
      return [{ plan_tier: 'self_hosted', name: organizationName }];
    }
    if (
      s.sql.startsWith('select') &&
      s.sql.includes('"memberships"') &&
      !s.sql.includes('"users"')
    ) {
      return [{ id: '01890a5d-ac96-774b-bcce-b302099a8071', role: 'owner' }];
    }
    if (s.sql.startsWith('insert into "invitations"')) {
      return [{ id: INV, send_count: 2, expires_at: new Date('2026-11-10T00:00:00Z') }];
    }
    if (
      s.sql.startsWith('select') &&
      s.sql.includes('"users"') &&
      !s.sql.includes('"memberships"')
    ) {
      return [{ display_name: displayName }];
    }
    return [];
  };
}

async function sendWith(organizationName: string, displayName: string | null) {
  const sent: InvitationSend[] = [];
  const { logger } = capturingLogger();
  const invitations = createInvitations(config, {
    db: {} as Database,
    authDb: {} as AuthDatabase,
    logger,
    limiter: noopLimiter(),
    store: scriptedStore(respond(organizationName, displayName)).store,
    mailer: {
      sendInvitation(_to, invitation) {
        sent.push(invitation);
        return Promise.resolve();
      },
    },
  });
  const access = grantAccess({
    organizationId: ORG,
    userId: USER,
    sessionId: SESSION,
    role: 'owner',
    defaultProjectRole: null,
    tier: 'self_hosted',
    authenticatedAt: AUTHENTICATED_AT,
  });
  const result = await invitations.invite(access, {
    email: 'newcomer@example.com',
    role: 'member',
    defaultProjectRole: null,
  });
  if (!result.ok || result.value.kind !== 'sent') throw new Error('expected sent');
  await result.value.send();
  const [mail] = sent;
  if (mail === undefined) throw new Error('nothing sent');
  return mail;
}

describe('names in the invitation mail', () => {
  it('reach the mailer as the exact stored text, never markup auth built', async () => {
    const mail = await sendWith('<b>Acme</b> & "Co"', '<img src=x onerror=alert(1)>');
    expect(mail.organizationName).toBe('<b>Acme</b> & "Co"');
    expect(mail.inviterName).toBe('<img src=x onerror=alert(1)>');
    expect(mail.sendCount).toBe(2);
    // Escaping happens once, where the mail is rendered; auth never pre escapes.
    expect(mail.organizationName).not.toContain('&amp;');
  });

  it.each([
    'Ada https://evil.example',
    'www.evil.example',
    'Ada at evil.example',
    'Ada at evil．example',
    'http://x',
  ])('replace an inviter name that reads as a link (%s) with plain wording', async (name) => {
    const mail = await sendWith('Acme Widgets', name);
    expect(mail.inviterName).toBe(INVITER_FALLBACK);
    expect(mail.inviterName).not.toMatch(/https?:|www\.|\.[a-z]{2,}/i);
  });

  it('use plain wording when the inviter has no display name, never their address', async () => {
    const mail = await sendWith('Acme Widgets', null);
    expect(mail.inviterName).toBe(INVITER_FALLBACK);
    expect(plainInviterName('   ')).toBe(INVITER_FALLBACK);
    expect(plainInviterName('Ada Lovelace')).toBe('Ada Lovelace');
  });
});
