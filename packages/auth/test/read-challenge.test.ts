import { describe, expect, it, vi } from 'vitest';
import { createEmailSignIn, formatChallengeId, sha256 } from '../src/index.ts';
import {
  ADDRESS,
  CHALLENGE,
  PRE,
  browser,
  challengeRow,
  config,
  emailResponder,
  unitDeps,
} from './email-fixtures.ts';
import { isWrite } from './scripted-store.ts';

const consumed = (row: Record<string, unknown>) => ({ ...row, consumed: true });
const OTHER = Buffer.alloc(32, 9);
const PUBLIC_ID = formatChallengeId(CHALLENGE);

function read(challenge: Record<string, unknown> | null) {
  const t = unitDeps(emailResponder({ challenge }));
  return { ...t, flow: createEmailSignIn(config, t.deps) };
}

describe('readChallenge', () => {
  it('names the address only to the browser that asked', async () => {
    const { flow } = read({ ...challengeRow(), consumed: false });
    const result = await flow.readChallenge(browser(), { challenge: PUBLIC_ID });
    expect(result).toEqual({
      ok: true,
      value: { kind: 'here', email: ADDRESS, purpose: 'sign_in', provider: null },
    });
  });

  it('says elsewhere and no address in any other browser', async () => {
    const { flow } = read({ ...challengeRow({ browserHash: sha256(OTHER) }), consumed: false });
    const result = await flow.readChallenge(browser(), { challenge: PUBLIC_ID });
    expect(result).toEqual({ ok: true, value: { kind: 'elsewhere' } });
  });

  it('says elsewhere to a browser with no pre sign in cookie', async () => {
    const { flow } = read({ ...challengeRow(), consumed: false });
    const result = await flow.readChallenge(browser(null), { challenge: PUBLIC_ID });
    expect(result).toEqual({ ok: true, value: { kind: 'elsewhere' } });
  });

  it.each([
    ['an unknown id', null],
    ['a spent challenge', consumed(challengeRow())],
    ['an expired challenge', { ...challengeRow({ live: false }), consumed: false }],
  ])('says gone for %s, in the browser that asked or any other', async (_name, row) => {
    const { flow } = read(row);
    expect(await flow.readChallenge(browser(), { challenge: PUBLIC_ID })).toEqual({
      ok: true,
      value: { kind: 'gone' },
    });
  });

  it('refuses an id of the wrong shape without a statement', async () => {
    const { flow, scripted } = read(challengeRow());
    expect(await flow.readChallenge(browser(), { challenge: 'not a uuid' })).toEqual({
      ok: true,
      value: { kind: 'gone' },
    });
    expect(scripted.statements()).toEqual([]);
  });

  it('with no id finds the newest open challenge of this browser', async () => {
    const { flow, scripted } = read({ ...challengeRow(), consumed: false });
    const result = await flow.readChallenge(browser(), {});
    expect(result).toMatchObject({ ok: true, value: { kind: 'here', email: ADDRESS } });
    const [statement] = scripted.statements();
    expect(statement?.sql).toContain('"browser_hash" = $');
    expect(statement?.parameters).toContainEqual(sha256(PRE));
  });

  it('with no id and no cookie sends nothing', async () => {
    const { flow, scripted } = read(challengeRow());
    expect(await flow.readChallenge(browser(null), {})).toEqual({
      ok: true,
      value: { kind: 'gone' },
    });
    expect(scripted.statements()).toEqual([]);
  });

  it('names the provider a link code would link', async () => {
    const { flow } = read({
      ...challengeRow({ purpose: 'link_identity' }),
      pending_provider: 'github',
      consumed: false,
    });
    expect(await flow.readChallenge(browser(), {})).toMatchObject({
      ok: true,
      value: { kind: 'here', purpose: 'link_identity', provider: 'github' },
    });
  });

  it('reads and never counts an attempt', async () => {
    const { flow, scripted, limiter } = read({ ...challengeRow(), consumed: false });
    const reserve = vi.spyOn(limiter, 'reserve');
    await flow.readChallenge(browser(), { challenge: PUBLIC_ID });
    expect(scripted.statements().filter((s) => isWrite(s))).toEqual([]);
    expect(reserve).not.toHaveBeenCalled();
  });

  it('answers unavailable when the read fails', async () => {
    const t = unitDeps(() => {
      throw new Error('connection reset');
    });
    const result = await createEmailSignIn(config, t.deps).readChallenge(browser(), {});
    expect(result).toMatchObject({ ok: false, error: { code: 'AUTH_UNAVAILABLE' } });
  });
});
