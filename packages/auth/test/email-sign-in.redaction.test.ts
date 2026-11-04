import type { AuthDatabase, Database } from '@drefyn/db';
import { idOf } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import {
  AuthError,
  createEmailSignIn,
  createInvitations,
  formatInvitationToken,
  parseAuthConfig,
  formatChallengeId,
  parseVerifyFragment,
  type AuthErrorCode,
} from '../src/index.ts';
import {
  ADDRESS,
  CHALLENGE,
  IP,
  PRE_COOKIE,
  browser,
  challengeRow,
  config,
  emailResponder,
  fakeLimiter,
  unitDeps,
} from './email-fixtures.ts';
import { scriptedStore } from './scripted-store.ts';
import { validEnv } from './support.ts';

// The fields a sign in failure log may carry: what happened, and hashed keys an operator can
// tie together. Nothing a person typed or was sent.
const ALLOWED_FIELDS = new Set(['outcome', 'bucket', 'key', 'purpose']);
const CODES: ReadonlySet<string> = new Set<AuthErrorCode>([
  'AUTH_CODE_INVALID',
  'AUTH_CHALLENGE_BINDING',
  'AUTH_CHALLENGE_EXPIRED',
  'AUTH_RATE_LIMITED',
  'AUTH_SIGNUP_CLOSED',
  'AUTH_UNAVAILABLE',
]);

describe('sign in logs', () => {
  it('never carry the address, code, challenge id, pre cookie or IP', async () => {
    const t = unitDeps(emailResponder({ challenge: challengeRow() }));
    t.mail.failNext();
    const flow = createEmailSignIn(config, t.deps);
    const start = await flow.startEmailSignIn(browser(), { email: ADDRESS });
    if (!start.ok) throw start.error;
    await start.value.send();
    const sent = t.mail.calls[0];
    const fragment = parseVerifyFragment(sent?.link.hash.slice(1));
    if (sent === undefined || fragment === null) throw new Error('the mailer was not called');

    const body = formatChallengeId(CHALLENGE);
    await flow.verifyEmailCode(browser(), { challenge: body, code: '11111111' });
    await flow.verifyEmailCode(browser(null), { challenge: body, code: sent.code });
    await flow.verifyEmailCode(browser(), { code: '22222222' });

    const limited = createEmailSignIn(config, {
      ...t.deps,
      limiter: fakeLimiter((bucket) => bucket === 'code_verify'),
    });
    await limited.verifyEmailCode(browser(), { challenge: body, code: '33333333' });

    expect(t.logs.map((l) => l.event)).toEqual(
      expect.arrayContaining(['auth.sign_in_mail_failed', 'auth.email_code_refused']),
    );
    const text = JSON.stringify(t.logs);
    for (const secret of [
      ADDRESS,
      'person',
      sent.code,
      '11111111',
      '22222222',
      '33333333',
      CHALLENGE,
      fragment.challengeId,
      body,
      PRE_COOKIE,
      IP,
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('carry only an outcome code and hashed bucket keys on a refusal', async () => {
    const t = unitDeps(emailResponder({ challenge: challengeRow() }));
    const flow = createEmailSignIn(config, t.deps);
    const body = formatChallengeId(CHALLENGE);
    await flow.verifyEmailCode(browser(), { challenge: body, code: '11111111' });
    await flow.verifyEmailCode(browser(null), { challenge: body, code: '11111111' });
    const refusals = t.logs.filter((l) => l.event === 'auth.email_code_refused');
    expect(refusals.map((l) => l.fields['outcome'])).toEqual([
      'AUTH_CODE_INVALID',
      'AUTH_CHALLENGE_BINDING',
    ]);
    for (const { fields } of refusals) {
      for (const [field, value] of Object.entries(fields)) {
        expect(ALLOWED_FIELDS.has(field)).toBe(true);
        if (field === 'key') expect(value).toMatch(/^[0-9a-f]{16}$/);
        if (field === 'outcome') expect(CODES.has(String(value))).toBe(true);
      }
    }
  });

  it('do not put the address into an error message either', async () => {
    const t = unitDeps(() => {
      throw new Error(`connection lost while reading ${ADDRESS}`);
    });
    const flow = createEmailSignIn(config, t.deps);
    const result = await flow.startEmailSignIn(browser(), { email: ADDRESS });
    expect(!result.ok && result.error).toBeInstanceOf(AuthError);
    expect(!result.ok && result.error.message).not.toContain(ADDRESS);
    expect(JSON.stringify(t.logs)).not.toContain(ADDRESS);
  });

  it('say only the organization when the invitation check meets a database that is down', async () => {
    const cfg = parseAuthConfig({ ...validEnv(), DREFYN_AUTH_SIGNUP: 'invite_only' });
    const organizationId = idOf('org', '01890a5d-ac96-774b-bcce-b302099a8070');
    const secret = Buffer.alloc(32, 5);
    const held = formatInvitationToken({
      organizationId,
      invitationId: idOf('inv', '01890a5d-ac96-774b-bcce-b302099a8072'),
      secret,
    });
    const down = scriptedStore(() => {
      throw new Error(`connection lost while checking ${ADDRESS} with ${held}`);
    });
    const t = unitDeps(emailResponder({ known: false }));
    const invitations = createInvitations(cfg, {
      db: {} as Database,
      authDb: {} as AuthDatabase,
      logger: t.deps.logger,
      mailer: {
        sendInvitation: () => Promise.resolve(),
        sendSecurityNotice: () => Promise.resolve(),
      },
      store: down.store,
    });
    const flow = createEmailSignIn(cfg, { ...t.deps, invitations });
    const b = browser();
    const cookies = new Map(b.cookies).set(cfg.cookies.invite, held);
    const start = await flow.startEmailSignIn({ ...b, cookies }, { email: ADDRESS });
    if (!start.ok) throw start.error;
    await start.value.send();
    // Answered as for any address, and no mail to a newcomer.
    expect(t.mail.calls).toHaveLength(0);
    const failed = t.logs.filter((l) => l.event === 'auth.invitation_check_failed');
    expect(failed).toEqual([
      {
        event: 'auth.invitation_check_failed',
        fields: { organizationId: 'org_' + held.slice(0, 26) },
      },
    ]);
    const text = JSON.stringify(t.logs);
    for (const value of [held, ADDRESS, 'person', secret.toString('hex'), held.slice(-52)]) {
      expect(text).not.toContain(value);
    }
  });
});
