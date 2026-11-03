import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildPasswordList,
  openBreachedPasswordFile,
  type BreachedPasswordCheck,
} from '../../src/index.ts';
import { newBrowser } from './support/email.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';
import {
  passwordConfig,
  passwordFlow,
  personWithPassword,
  phcOf,
  sessionsOf,
  signInFrom,
} from './support/passwords.ts';

const BREACHED = 'a password everyone has used';
const RARE = 'listed once and so dropped';
const fresh = harness();
let h: Harness;
let dir: string;
let list: string;

const line = (password: string, count: number) =>
  `${createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase()}:${String(count)}\r\n`;

async function personWithoutPassword(flow: ReturnType<typeof passwordFlow>) {
  const email = `b${String(Date.now())}${String(Math.random()).slice(2, 8)}@example.com`;
  const userId = await h.user(email);
  const started = await flow.sessions.startSession(newBrowser().context(), {
    userId,
    method: 'email',
  });
  return { email, session: started.session };
}

describeWithStack('the breached password list against Postgres', () => {
  beforeAll(async () => {
    h = await fresh();
    dir = await mkdtemp(join(tmpdir(), 'drefyn-breached-int-'));
    const from = join(dir, 'pwned.txt');
    // The shape the Pwned Passwords downloader writes, out of order on purpose.
    await writeFile(
      from,
      line('some other listed sentence', 50) + line(BREACHED, 40) + line(RARE, 1),
    );
    list = join(dir, 'breached.bin');
    await buildPasswordList({ from, out: list, minCount: 2 });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a breached password is refused when set and nothing is stored', async () => {
    const flow = passwordFlow(h, passwordConfig({ DREFYN_AUTH_BREACHED_PASSWORDS_FILE: list }));
    const { email, session } = await personWithoutPassword(flow);
    const refused = await flow.signIn.setPassword(session, { newPassword: BREACHED });
    expect(!refused.ok && refused.error.code).toBe('AUTH_PASSWORD_BREACHED');
    expect(await phcOf(h, email)).toBe('-');
    // Under the minimum count, so the build dropped it.
    const rare = await flow.signIn.setPassword(session, { newPassword: RARE });
    expect(rare.ok).toBe(true);
    expect(await phcOf(h, email)).toMatch(/^\$argon2id\$/);
    expect(h.logs.some((l) => JSON.stringify(l).includes(BREACHED))).toBe(false);
  });

  it('is not checked at sign in: a password set before the list arrived still signs in', async () => {
    const before = passwordFlow(h, passwordConfig());
    const { email } = await personWithPassword(h, before, BREACHED);
    const file = await openBreachedPasswordFile(list);
    let asked = 0;
    const counting: BreachedPasswordCheck = {
      isBreached(password, signal) {
        asked += 1;
        return file.isBreached(password, signal);
      },
    };
    try {
      const after = passwordFlow(h, passwordConfig(), undefined, {
        breachedPasswords: counting,
      });
      const result = await signInFrom(after, newBrowser(), email, BREACHED);
      expect(result.ok).toBe(true);
      expect(await sessionsOf(h, email)).toBe('1');
      expect(asked).toBe(0);
    } finally {
      await file.close();
    }
  });

  it('with DREFYN_AUTH_BREACHED_PASSWORDS_FILE unset, the built in rules still refuse their families', async () => {
    const config = passwordConfig();
    expect(config.passwords.breachedPasswordsFile).toBeNull();
    const flow = passwordFlow(h, config);
    const { email, session } = await personWithoutPassword(flow);
    const families: [string, string][] = [
      ['zzzzzzzzzzzzzzzzzz', 'repeated_character'],
      ['0123456789abcdefgh', 'sequence'],
      ['asdfghjklqwertyuiop', 'keyboard_walk'],
      ['ab1!ab1!ab1!ab1!ab', 'repeated_unit'],
      [`${email.split('@')[0] ?? ''} and more words`, 'context'],
    ];
    for (const [password, rule] of families) {
      const result = await flow.signIn.setPassword(session, { newPassword: password });
      expect(!result.ok && result.error.rules, password).toContain(rule);
    }
    expect(await phcOf(h, email)).toBe('-');
    expect(h.logs.some((l) => l.event === 'auth.breach_list_absent')).toBe(true);
  });
});
