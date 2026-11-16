import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthError } from '@drefyn/auth';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkSsoDomainLists,
  forgetSsoDomainPolicy,
  ssoDomainPolicy,
} from '../src/server/sso-domain-lists.ts';

const dir = mkdtempSync(join(tmpdir(), 'drefyn-sso-lists-'));
const file = (name: string, text: string) => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};
const EXTRA = file('extra.txt', '# ours\nmail.acme-free.example\nposteo.example\n');
const BAD = file('bad.txt', 'mail.acme-free.example\nhttps://secret-line.example/x\n');

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  forgetSsoDomainPolicy();
});

function check(path: string | null, deps?: Parameters<typeof checkSsoDomainLists>[0]['deps']) {
  const exit = vi.fn<(code: number) => void>();
  const log = vi.fn<(event: string, context: Record<string, string | number>) => void>();
  return {
    exit,
    log,
    done: checkSsoDomainLists({ file: path, exit, log, ...(deps ? { deps } : {}) }),
  };
}

describe('checkSsoDomainLists', () => {
  it('reads the bundled Public Suffix List with no extra file', async () => {
    const { exit, log, done } = check(null);
    await done;
    expect(exit).not.toHaveBeenCalled();
    const [event, context] = log.mock.calls[0] ?? [];
    expect(event).toBe('dashboard.sso_lists_loaded');
    expect(context?.['extraFreeMail']).toBe(0);
    expect(Number(context?.['publicSuffixes'])).toBeGreaterThan(5000);
  });

  it('adds the domains of the free mail file', async () => {
    const { log, done } = check(EXTRA);
    await done;
    expect(log.mock.calls[0]?.[1]).toMatchObject({ extraFreeMail: 2 });
    const policy = await ssoDomainPolicy(EXTRA);
    expect(policy.refusal('eu.posteo.example')).toBe('free_mail');
    expect(policy.refusal('co.uk')).toBe('public_suffix');
    expect(policy.refusal('acme.example')).toBeNull();
  });

  it('stops the start on a bad file, naming the key and never a line of it', async () => {
    const { exit, log, done } = check(BAD);
    await done;
    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledWith('dashboard.config_invalid', {
      code: 'AUTH_CONFIG_INVALID',
      key: 'DREFYN_AUTH_SSO_FREE_MAIL_DOMAINS_FILE',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-line');
  });

  it('stops the start on a file that is not there', async () => {
    const { exit, log, done } = check(join(dir, 'missing.txt'));
    await done;
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.mock.calls[0]?.[1]).toMatchObject({ key: 'DREFYN_AUTH_SSO_FREE_MAIL_DOMAINS_FILE' });
  });

  // A build that left the data folder behind must not start and quietly let every suffix be
  // claimed.
  it('stops the start when the bundled list cannot be read', async () => {
    const { exit, log, done } = check(null, {
      loadSuffixes: () =>
        Promise.reject(Object.assign(new Error('ENOENT /srv/app/data'), { code: 'ENOENT' })),
    });
    await done;
    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledWith('dashboard.config_invalid', { code: 'ENOENT' });
  });
});

describe('ssoDomainPolicy', () => {
  it('loads once per process and tries again after a failure', async () => {
    const loadSuffixes = vi
      .fn()
      .mockRejectedValueOnce(new AuthError('AUTH_CONFIG_INVALID', { reason: 'empty' }))
      .mockResolvedValue({ size: 1, isPublicSuffix: (d: string) => d === 'example' });
    await expect(ssoDomainPolicy(null, { loadSuffixes })).rejects.toBeInstanceOf(AuthError);
    const first = await ssoDomainPolicy(null, { loadSuffixes });
    const second = await ssoDomainPolicy(null, { loadSuffixes });
    expect(second).toBe(first);
    expect(loadSuffixes).toHaveBeenCalledTimes(2);
  });
});
