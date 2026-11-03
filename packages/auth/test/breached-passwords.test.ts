import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BREACH_CHECK_TIMEOUT_MS, askBreached } from '../src/breach-check.ts';
import { lazyBreachedPasswordFile } from '../src/breached-file.ts';
import {
  AuthError,
  BREACHED_RECORD_BYTES,
  breachedDigest,
  openBreachedPasswordFile,
  type AuthLogger,
  type AuthMetricName,
  type BreachedPasswordCheck,
} from '../src/index.ts';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drefyn-breached-unit-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

async function listOf(name: string, passwords: readonly string[]): Promise<string> {
  const path = join(dir, name);
  const records = passwords.map(breachedDigest).sort(Buffer.compare);
  await writeFile(path, Buffer.concat(records));
  return path;
}

function recorder() {
  const logs: { level: string; event: string; fields: Readonly<Record<string, unknown>> }[] = [];
  const counted: AuthMetricName[] = [];
  const logger: AuthLogger = {
    warn(event, fields) {
      logs.push({ level: 'warn', event, fields });
    },
    info(event, fields) {
      logs.push({ level: 'info', event, fields });
    },
  };
  const metrics = {
    increment(name: AuthMetricName) {
      counted.push(name);
    },
  };
  return { logs, counted, logger, metrics };
}

describe('record encoding', () => {
  it('is the SHA-1 of the UTF-8 password, 20 bytes, as Pwned Passwords lists it', () => {
    expect(BREACHED_RECORD_BYTES).toBe(20);
    const digest = breachedDigest('password');
    expect(digest).toHaveLength(BREACHED_RECORD_BYTES);
    expect(digest.toString('hex').toUpperCase()).toBe('5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8');
  });

  it('folds to NFKC first, the form a password is hashed in', () => {
    expect(breachedDigest('ｐａｓｓｗｏｒｄ')).toEqual(breachedDigest('password'));
    expect(breachedDigest('café')).toEqual(breachedDigest('café'));
  });
});

describe('openBreachedPasswordFile', () => {
  it('finds a listed password and nothing else', async () => {
    const file = await openBreachedPasswordFile(
      await listOf('three.bin', ['password', 'letmein please', 'correct horse battery']),
    );
    try {
      const signal = new AbortController().signal;
      expect(file.records).toBe(3);
      await expect(file.isBreached('letmein please', signal)).resolves.toBe(true);
      await expect(file.isBreached('a long and quiet sentence', signal)).resolves.toBe(false);
    } finally {
      await file.close();
    }
  });

  it('an empty list holds nothing', async () => {
    const file = await openBreachedPasswordFile(await listOf('empty.bin', []));
    try {
      expect(file.records).toBe(0);
      await expect(file.contains(breachedDigest('password'))).resolves.toBe(false);
    } finally {
      await file.close();
    }
  });

  it('gives no answer once the caller has given up', async () => {
    const file = await openBreachedPasswordFile(await listOf('abort.bin', ['password']));
    try {
      const gone = new AbortController();
      gone.abort();
      await expect(file.isBreached('password', gone.signal)).resolves.toBeNull();
    } finally {
      await file.close();
    }
  });

  it('refuses a file that is not whole records, a folder and a missing path', async () => {
    const torn = join(dir, 'torn.bin');
    await writeFile(torn, Buffer.alloc(BREACHED_RECORD_BYTES * 2 + 7));
    const folder = join(dir, 'folder.bin');
    await mkdir(folder);
    for (const path of [torn, folder]) {
      const error = await openBreachedPasswordFile(path).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AuthError);
      expect(error).toMatchObject({
        code: 'AUTH_CONFIG_INVALID',
        key: 'DREFYN_AUTH_BREACHED_PASSWORDS_FILE',
      });
    }
    await expect(openBreachedPasswordFile(join(dir, 'nowhere.bin'))).rejects.toThrow();
  });

  it('opens lazily, and tries again after a failure instead of keeping it', async () => {
    const path = join(dir, 'later.bin');
    const check = lazyBreachedPasswordFile(path);
    const signal = new AbortController().signal;
    await expect(check.isBreached('password', signal)).rejects.toThrow();
    await listOf('later.bin', ['password']);
    await expect(check.isBreached('password', signal)).resolves.toBe(true);
    await expect(check.isBreached('something else entirely', signal)).resolves.toBe(false);
  });
});

describe('askBreached', () => {
  const fields = { userId: 'usr_x' };

  it('with no check, accepts and says nothing', async () => {
    const r = recorder();
    await expect(askBreached(undefined, 'password', { ...r, fields })).resolves.toBe(false);
    expect(r.logs).toEqual([]);
    expect(r.counted).toEqual([]);
  });

  it('refuses what the check calls breached and accepts what it clears', async () => {
    const r = recorder();
    const check: BreachedPasswordCheck = {
      isBreached: (password) => Promise.resolve(password === 'password'),
    };
    await expect(askBreached(check, 'password', { ...r, fields })).resolves.toBe(true);
    await expect(askBreached(check, 'other', { ...r, fields })).resolves.toBe(false);
    expect(r.counted).toEqual([]);
  });

  it('a stalled check accepts after the timeout, aborts it, and logs and counts it', async () => {
    vi.useFakeTimers();
    const r = recorder();
    let seen: AbortSignal | undefined;
    const stalled: BreachedPasswordCheck = {
      isBreached(_password, signal) {
        seen = signal;
        return new Promise(() => undefined);
      },
    };
    let settled = false;
    const answer = askBreached(stalled, 'password', { ...r, fields }).then((v) => {
      settled = true;
      return v;
    });
    await vi.advanceTimersByTimeAsync(BREACH_CHECK_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toBe(false);
    expect(seen?.aborted).toBe(true);
    expect(r.counted).toEqual(['auth.breach_check_unavailable']);
    expect(r.logs).toEqual([
      {
        level: 'warn',
        event: 'auth.breach_check_unavailable',
        fields: { userId: 'usr_x', reason: 'timeout' },
      },
    ]);
  });

  it('a check that fails or has no answer accepts, logged and counted with the reason', async () => {
    const r = recorder();
    const failing: BreachedPasswordCheck = {
      isBreached: () => Promise.reject(new Error('disk gone')),
    };
    const silent: BreachedPasswordCheck = { isBreached: () => Promise.resolve(null) };
    await expect(askBreached(failing, 'password', { ...r, fields })).resolves.toBe(false);
    await expect(askBreached(silent, 'password', { ...r, fields })).resolves.toBe(false);
    expect(r.logs.map((l) => l.fields['reason'])).toEqual(['error', 'no_answer']);
    expect(r.counted).toEqual(['auth.breach_check_unavailable', 'auth.breach_check_unavailable']);
    expect(JSON.stringify(r.logs)).not.toContain('disk gone');
  });

  it('a check that throws before returning a promise is handled the same', async () => {
    const r = recorder();
    const throwing: BreachedPasswordCheck = {
      isBreached() {
        throw new Error('bad');
      },
    };
    await expect(askBreached(throwing, 'password', { ...r, fields })).resolves.toBe(false);
    expect(r.logs.map((l) => l.fields['reason'])).toEqual(['error']);
  });

  it('a log sink or counter that throws never turns an answer into a failure', async () => {
    const broken = {
      logger: {
        warn() {
          throw new Error('sink');
        },
      },
      metrics: {
        increment() {
          throw new Error('counter');
        },
      },
    };
    const silent: BreachedPasswordCheck = { isBreached: () => Promise.resolve(null) };
    await expect(askBreached(silent, 'password', { ...broken, fields })).resolves.toBe(false);
  });

  it('a file lookup answers well inside the timeout', async () => {
    const r = recorder();
    const file = await openBreachedPasswordFile(await listOf('quick.bin', ['password']));
    try {
      await expect(askBreached(file, 'password', { ...r, fields })).resolves.toBe(true);
      expect(r.logs).toEqual([]);
    } finally {
      await file.close();
    }
  });
});
