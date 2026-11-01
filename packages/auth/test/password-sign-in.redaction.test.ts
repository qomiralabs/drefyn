import { describe, expect, it } from 'vitest';
import { AuthError, createPasswordSignIn, redact, type AuthLogger } from '../src/index.ts';
import type { Argon2Function } from '../src/password-hash.ts';
import { smallHasher } from './password-fixtures.ts';
import {
  ADDRESS,
  IP,
  PRE_COOKIE,
  config,
  configWith,
  csrfFor,
  passwordBrowser,
  passwordDeps,
  session,
} from './password-sign-in-fixtures.ts';

const SECRET_PASSWORD = 'Plum-Kestrel-Harbour-9931-quietly';

// Every way a value could leave: log events and fields, error messages, causes and their
// serialised forms.
function everything(logs: readonly unknown[], results: readonly unknown[]): string {
  const parts: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || value === null || value === undefined) return;
    if (value instanceof Error) {
      parts.push(String(value), value.message, String(value.stack));
      visit(value.cause, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const inner of Object.values(value)) visit(inner, depth + 1);
      return;
    }
    parts.push(String(value));
  };
  for (const item of [...logs, ...results]) {
    parts.push(JSON.stringify(item) ?? '');
    visit(item, 0);
  }
  return parts.join('\n');
}

describe('passwords never reach logs or errors', () => {
  it('on every path of sign in and set password', async () => {
    const stored = await smallHasher().hash('the right one, not this');
    const logs: unknown[] = [];
    const logger: AuthLogger = {
      warn: (event, fields) => logs.push({ event, fields }),
      info: (event, fields) => logs.push({ event, fields }),
    };
    const results: unknown[] = [];
    const run = async (deps: ReturnType<typeof passwordDeps>['deps'], c = config) => {
      const flow = createPasswordSignIn(c, { ...deps, logger });
      results.push(
        await flow.signInWithPassword(passwordBrowser(c), {
          email: ADDRESS,
          password: SECRET_PASSWORD,
          csrf: csrfFor(c),
        }),
      );
      results.push(await flow.setPassword(session, { newPassword: SECRET_PASSWORD }));
      results.push(await flow.setPassword(session, { newPassword: `${SECRET_PASSWORD} drefyn` }));
    };
    await run(passwordDeps({ known: true, phc: stored }).deps);
    await run(passwordDeps({ known: false }).deps);
    await run(passwordDeps({ known: true, phc: '$argon2i$broken' }).deps);
    await run(
      passwordDeps({ known: true, phc: stored }).deps,
      configWith({ DREFYN_AUTH_SIGNUP: 'open' }),
    );
    const broken: Argon2Function = (_a, parameters, callback) => {
      callback(new Error(`argon2 failed on ${String(parameters.message)}`), Buffer.alloc(0));
    };
    await run(
      passwordDeps({ known: true, phc: stored }, { hasher: smallHasher({ argon2: broken }) }).deps,
    );
    const db = passwordDeps({ known: true, phc: stored });
    db.scripted.respondWith(() => {
      throw new Error('db down');
    });
    await run(db.deps);
    const bot = passwordDeps(
      { known: true, phc: stored },
      {
        botCheck: { verify: () => Promise.reject(new Error('bot check down')) },
      },
    );
    await run(bot.deps);

    expect(results.length).toBeGreaterThan(10);
    expect(logs.length).toBeGreaterThan(0);
    // Results may name the signed in address; they never carry the password, not even in a
    // cause. Logs carry neither, nor the pre cookie or the IP.
    expect(everything([], results)).not.toContain(SECRET_PASSWORD);
    const logged = everything(logs, []);
    for (const value of [SECRET_PASSWORD, ADDRESS, PRE_COOKIE, IP]) {
      expect(logged).not.toContain(value);
    }
    for (const r of results as { ok: boolean; error?: AuthError }[]) {
      if (r.ok) continue;
      expect(r.error?.message).not.toContain(SECRET_PASSWORD);
      expect(JSON.stringify(r.error)).not.toContain(SECRET_PASSWORD);
    }
  });

  it('a log line carries only fixed event names and public ids', async () => {
    const t = passwordDeps({ known: true, phc: '$argon2i$broken' });
    const flow = createPasswordSignIn(config, t.deps);
    await flow.signInWithPassword(passwordBrowser(), {
      email: ADDRESS,
      password: SECRET_PASSWORD,
      csrf: csrfFor(config),
    });
    for (const line of t.logs) {
      expect(line.event).toMatch(/^auth\.[a-z_]+$/);
      for (const value of Object.values(line.fields)) {
        expect(String(value)).toMatch(
          /^(usr|ses)_[0-9a-z]+$|^AUTH_[A-Z_]+$|^[0-9a-f]{16}$|^password_fail(_ip)?$/,
        );
      }
    }
  });

  it('the hasher keeps the password out of its own failures', async () => {
    const broken: Argon2Function = (_a, parameters, callback) => {
      callback(
        new Error(`failed on ${Buffer.from(parameters.message as Buffer).toString()}`),
        Buffer.alloc(0),
      );
    };
    const error = await smallHasher({ argon2: broken })
      .hash(SECRET_PASSWORD)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect(JSON.stringify(redact(error))).not.toContain(SECRET_PASSWORD);
    expect(everything([], [error])).not.toContain(SECRET_PASSWORD);
  });
});
