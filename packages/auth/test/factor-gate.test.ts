import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { idOf, organizationId } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import * as packageEntry from '../src/index.ts';
import { mintFactorProof } from '../src/factor-proof.ts';
import { parseFactorToken } from '../src/tokens.ts';
import {
  factorConfig,
  isChallengeDelete,
  isChallengeInsert,
  isCredentialRead,
  isFactorLock,
} from './factor-fixtures.ts';
import type { Responder } from './scripted-store.ts';
import {
  OTHER_USER,
  USER,
  browser,
  isProof,
  sessionResponder,
  sessionInfo,
  sessionRow,
  setup,
  tokenFor,
} from './session-fixtures.ts';

const SRC = join(import.meta.dirname, '..', 'src');

// A store that also answers the session insert, as the database would.
function inserting(base: Responder = sessionResponder([sessionRow()])): Responder {
  return (s) =>
    /^insert into "sessions"/i.test(s.sql)
      ? [
          {
            id: '01890a5d-ac96-774b-bcce-b302099a8099',
            authenticated_at: new Date(),
            expires_at: new Date(),
          },
        ]
      : base(s);
}

// A person with a confirmed factor: the credential read answers one row.
function enrolled(base: Responder = inserting()): Responder {
  return (s) => {
    if (isCredentialRead(s)) return [{ user_id: USER }];
    if (s.sql.includes('from "password_credentials"')) return [{ user_id: USER }];
    return base(s);
  };
}

describe('startSession with a factor enrolled', () => {
  it('writes a challenge, no session, and sets the factor cookie for ten minutes', async () => {
    const { sessions, scripted } = setup(enrolled(), {}, factorConfig);
    const done = await sessions.startSession(browser(), {
      userId: USER,
      method: 'email',
      returnTo: '/acme',
    });
    expect(done.kind).toBe('factor_required');
    const statements = scripted.statements();
    expect(statements.some((s) => /^insert into "sessions"/i.test(s.sql))).toBe(false);
    expect(statements.findIndex(isChallengeDelete)).toBeLessThan(
      statements.findIndex(isChallengeInsert),
    );
    const insert = statements.find(isChallengeInsert);
    expect(insert?.parameters).toContain('email');
    expect(insert?.parameters).toContain('/acme');
    expect(insert?.sql).toContain("interval '600 seconds'");
    const factor = done.setCookies.find((c) => c.name === factorConfig.cookies.factor);
    expect(factor?.maxAgeSeconds).toBe(600);
    const token = parseFactorToken(factor?.value);
    expect(token?.userId).toBe(USER);
    // Stored as the hash of the secret the cookie carries, never the secret.
    expect(insert?.parameters).toContainEqual(
      packageEntry.sha256(token?.secret ?? Buffer.alloc(0)),
    );
    expect(insert?.parameters).not.toContainEqual(token?.secret);
  });

  it('keeps the pre sign in cookie for the challenge form, and clears the OAuth one', async () => {
    const { sessions } = setup(enrolled(), {}, factorConfig);
    const done = await sessions.startSession(browser(), { userId: USER, method: 'github' });
    const names = done.setCookies.map((c) => c.name);
    expect(names).not.toContain(factorConfig.cookies.pre);
    expect(names).not.toContain(factorConfig.cookies.session);
    expect(done.setCookies).toContainEqual({
      name: factorConfig.cookies.oauth,
      value: '',
      maxAgeSeconds: 0,
    });
  });

  it('takes the shared lock first, then reads the credential', async () => {
    const { sessions, scripted } = setup(enrolled(), {}, factorConfig);
    await sessions.startSession(browser(), { userId: USER, method: 'email' });
    const statements = scripted.statements();
    expect(isFactorLock(statements[0] ?? { sql: '', parameters: [] })).toBe(true);
    expect(statements[0]?.sql).toContain('pg_advisory_xact_lock_shared');
    expect(statements.findIndex(isCredentialRead)).toBe(1);
    expect(statements[1]?.sql).toContain('"confirmed_at" is not null');
  });

  it('leaves the browser’s old session alone until the factor passes', async () => {
    const { sessions, scripted } = setup(enrolled(), {}, factorConfig);
    await sessions.startSession(browser({ [factorConfig.cookies.session]: tokenFor() }), {
      userId: USER,
      method: 'email',
    });
    expect(scripted.statements().some(isProof)).toBe(false);
  });

  it('holds the password row and writes the rehash before the challenge', async () => {
    const { sessions, scripted } = setup(enrolled(), {}, factorConfig);
    const done = await sessions.startSession(browser(), {
      userId: USER,
      method: 'password',
      credential: { phc: '$old', rehash: '$new' },
    });
    expect(done.kind).toBe('factor_required');
    const statements = scripted.statements();
    const held = statements.findIndex((s) => s.sql.includes('from "password_credentials"'));
    const rehash = statements.findIndex((s) => s.sql.startsWith('update "password_credentials"'));
    expect(statements[held]?.sql).toMatch(/for update$/);
    expect(held).toBeGreaterThan(statements.findIndex(isFactorLock));
    expect(rehash).toBeGreaterThan(held);
    expect(rehash).toBeLessThan(statements.findIndex(isChallengeInsert));
  });

  it('refuses a password whose hash changed since the check, with no challenge', async () => {
    const base = enrolled();
    const { sessions, scripted } = setup(
      (s) => (s.sql.includes('from "password_credentials"') ? [] : base(s)),
      {},
      factorConfig,
    );
    await expect(
      sessions.startSession(browser(), {
        userId: USER,
        method: 'password',
        credential: { phc: '$old' },
      }),
    ).rejects.toMatchObject({ code: 'AUTH_CREDENTIALS_INVALID' });
    expect(scripted.statements().some(isChallengeInsert)).toBe(false);
  });

  it('stores the SSO scope on the challenge so the session can carry it later', async () => {
    const { sessions, scripted } = setup(enrolled(), {}, factorConfig);
    const sso = {
      organizationId: organizationId('01890a5d-ac96-774b-bcce-b302099a8070'),
      connectionId: idOf('ssc', '01890a5d-ac96-774b-bcce-b302099a8071'),
    };
    await sessions.startSession(browser(), { userId: USER, method: 'sso', sso });
    const insert = scripted.statements().find(isChallengeInsert);
    expect(insert?.parameters).toContain(sso.connectionId);
    expect(insert?.parameters).toContain(sso.organizationId);
  });
});

describe('startSession with no factor', () => {
  it('starts a session as before, after the lock and the read', async () => {
    const { sessions, scripted } = setup(inserting(), {}, factorConfig);
    const done = await sessions.startSession(browser(), { userId: USER, method: 'email' });
    expect(done.kind).toBe('session');
    const statements = scripted.statements();
    expect(isFactorLock(statements[0] ?? { sql: '', parameters: [] })).toBe(true);
    expect(statements.findIndex(isCredentialRead)).toBe(1);
    expect(statements.some(isChallengeInsert)).toBe(false);
  });

  it('retires the browser’s old session once the new one exists', async () => {
    const { sessions, scripted } = setup(inserting(), {}, factorConfig);
    await sessions.startSession(browser({ [factorConfig.cookies.session]: tokenFor() }), {
      userId: USER,
      method: 'email',
    });
    const statements = scripted.statements();
    const inserted = statements.findIndex((s) => /^insert into "sessions"/i.test(s.sql));
    expect(statements.findIndex(isProof)).toBeGreaterThan(inserted);
  });
});

describe('the factor proof', () => {
  it('lets a session start for the person it names, once', async () => {
    const { sessions } = setup(enrolled(), {}, factorConfig);
    const proof = mintFactorProof(USER, 'totp');
    const first = await sessions.startSession(browser(), {
      userId: USER,
      method: 'email',
      factor: proof,
    });
    expect(first.kind).toBe('session');
    await expect(
      sessions.startSession(browser(), { userId: USER, method: 'email', factor: proof }),
    ).rejects.toMatchObject({ code: 'AUTH_INPUT_INVALID' });
  });

  it('is refused for anyone else, with no statement', async () => {
    const { sessions, scripted } = setup(enrolled(), {}, factorConfig);
    const proof = mintFactorProof(OTHER_USER, 'totp');
    await expect(
      sessions.startSession(browser(), { userId: USER, method: 'email', factor: proof }),
    ).rejects.toMatchObject({ code: 'AUTH_INPUT_INVALID' });
    expect(scripted.statements()).toEqual([]);
  });

  it('cannot be forged by copying its shape', async () => {
    const { sessions } = setup(enrolled(), {}, factorConfig);
    const forged = { ...mintFactorProof(USER, 'totp') };
    await expect(
      sessions.startSession(browser(), {
        userId: USER,
        method: 'email',
        factor: forged,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_INPUT_INVALID' });
  });

  it('is not exported from the package', () => {
    expect(Object.keys(packageEntry)).not.toContain('mintFactorProof');
    expect(Object.keys(packageEntry)).not.toContain('spendFactorProof');
    const entry = readFileSync(join(SRC, 'index.ts'), 'utf8');
    expect(entry).not.toMatch(/FactorProof|factor-proof/);
  });

  it('is minted only by the factor check', () => {
    const minting = readdirSync(SRC)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => /\bmintFactorProof\b/.test(readFileSync(join(SRC, name), 'utf8')));
    expect(minting.sort()).toEqual(['factor-proof.ts', 'factor-verify.ts']);
  });
});

describe('sessions rows', () => {
  it('are inserted by sessions.ts alone', () => {
    const inserting = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .filter((name) =>
        /insertInto\(\s*'sessions'\s*\)/.test(readFileSync(join(SRC, name), 'utf8')),
      );
    expect(inserting).toEqual(['sessions.ts']);
  });
});

describe('the guard reads', () => {
  // The factor is checked once, at sign in; a live session is never asked again.
  it('resolve and resolveAccess send no statement about the factor', async () => {
    const base = sessionResponder([sessionRow()]);
    const { sessions, scripted } = setup(
      (s) => (s.sql.includes('"organization_slugs"') ? [] : base(s)),
      {},
      factorConfig,
    );
    await sessions.resolve(tokenFor());
    await sessions.resolveAccess(tokenFor(), 'acme');
    const text = scripted
      .statements()
      .map((s) => s.sql)
      .join('\n');
    expect(text).not.toMatch(/totp_credentials|factor_challenges|recovery_codes|advisory/);
    // The proof and the user read for resolve; the proof and the membership read for access.
    expect(scripted.statements()).toHaveLength(4);
  });
});

describe('signOutOtherSessions', () => {
  it('takes the shared lock before it reads the sessions it reissues', async () => {
    const { sessions, scripted } = setup((s) => {
      if (/for update$/i.test(s.sql)) {
        return [{ id: sessionRow()['id'], live: true, recent: true, seconds_left: 1000 }];
      }
      if (/^insert into "sessions"/i.test(s.sql)) {
        return [{ id: '01890a5d-ac96-774b-bcce-b302099a8099' }];
      }
      return [];
    });
    await sessions.signOutOtherSessions(sessionInfo(), browser());
    const statements = scripted.statements();
    expect(isFactorLock(statements[0] ?? { sql: '', parameters: [] })).toBe(true);
    expect(statements.some(isChallengeDelete)).toBe(true);
  });
});
