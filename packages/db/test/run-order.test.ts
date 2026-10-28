import { describe, expect, it } from 'vitest';
import type { RecordedMigration } from '../src/checksum.ts';
import type { RoleAccess, VectorExtension } from '../src/prerequisites.ts';
import {
  runMigrate,
  type ConnectedRole,
  type InvalidIndex,
  type MigrateSession,
  type Output,
  type RunRequest,
} from '../src/run.ts';
import { migrationText, migrationsDir } from './support.ts';

const URL = 'postgres://drefyn_owner:Sup3r-Secret-Pa55word@127.0.0.1:55432/drefyn';
const ENV = { DREFYN_MIGRATION_DATABASE_URL: URL, DREFYN_DATABASE_SSL: 'disable' };
const A = '1760000000001_a.sql';
const B = '1760000000002_b.sql';

function capture(): Output & { text: () => string } {
  const chunks: string[] = [];
  return { write: (t: string) => void chunks.push(t), text: () => chunks.join('') };
}

interface FakeState {
  invalid?: InvalidIndex[];
  role?: ConnectedRole;
  vector?: VectorExtension | undefined;
  roles?: RoleAccess[];
  lockFree?: boolean;
  trackingProblem?: string;
  history?: RecordedMigration[];
  runError?: Error;
  unlockError?: Error;
  closeError?: Error;
}

// Records every call in order, so a test can say what ran before what and what never ran.
function fakeSession(state: FakeState = {}) {
  const calls: string[] = [];
  const runs: RunRequest[] = [];
  const session: MigrateSession = {
    role: () => {
      calls.push('role');
      return Promise.resolve(
        state.role ?? { name: 'drefyn_owner', superuser: false, bypassRls: false },
      );
    },
    vectorExtension: () => {
      calls.push('prerequisites');
      return Promise.resolve(
        'vector' in state ? state.vector : { schema: 'extensions', version: '0.8.7' },
      );
    },
    requiredRoles: () => {
      calls.push('roles');
      return Promise.resolve(
        state.roles ?? [{ role: 'drefyn_auth', exists: true, canConnect: true }],
      );
    },
    invalidIndexes: () => {
      calls.push('indexes');
      return Promise.resolve(state.invalid ?? []);
    },
    tryLock: () => {
      calls.push('lock');
      return Promise.resolve(state.lockFree ?? true);
    },
    unlock: () => {
      calls.push('unlock');
      return state.unlockError ? Promise.reject(state.unlockError) : Promise.resolve();
    },
    setLockTimeout: () => {
      calls.push('lock_timeout');
      return Promise.resolve();
    },
    trackingTableProblem: () => {
      calls.push('shape');
      return Promise.resolve(state.trackingProblem);
    },
    history: () => {
      calls.push('history');
      return Promise.resolve(state.history ?? []);
    },
    ensureBookkeeping: () => {
      calls.push('bookkeeping');
      return Promise.resolve();
    },
    run: (request) => {
      calls.push(`run ${request.direction}`);
      runs.push(request);
      return state.runError ? Promise.reject(state.runError) : Promise.resolve();
    },
    close: () => {
      calls.push('close');
      return state.closeError ? Promise.reject(state.closeError) : Promise.resolve();
    },
  };
  return { session, calls, runs };
}

const folder = () =>
  migrationsDir({
    [A]: migrationText('select 1;', 'select 1;'),
    [B]: migrationText('select 2;', 'select 2;'),
  });

async function migrate(argv: string[], state: FakeState = {}, dir = folder()) {
  const fake = fakeSession(state);
  const stdout = capture();
  const stderr = capture();
  const code = await runMigrate({
    argv: [...argv, '--migrations-dir', dir],
    env: ENV,
    stdout,
    stderr,
    connect: () => Promise.resolve(fake.session),
  });
  return { code, stdout: stdout.text(), stderr: stderr.text(), ...fake, dir };
}

// The hash of the fixture files as the folder above writes them.
async function hashes(dir: string): Promise<Record<string, string>> {
  const { loadMigrationFiles } = await import('../src/migration-file.ts');
  const files = await loadMigrationFiles(dir);
  return Object.fromEntries(files.map((f) => [f.name.replace(/\.sql$/, ''), f.sha256]));
}

describe('runMigrate order', () => {
  it('runs up in the agreed order and exits 0', async () => {
    const r = await migrate(['migrate', 'up']);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([
      'role',
      'prerequisites',
      'roles',
      'indexes',
      'lock',
      'lock_timeout',
      'shape',
      'history',
      'bookkeeping',
      'run up',
      'unlock',
      'close',
    ]);
    expect(r.runs[0]?.count).toBe(Number.POSITIVE_INFINITY);
    expect(r.runs[0]?.files.map((f) => f.name)).toEqual([A, B]);
  });

  it('passes the down count through', async () => {
    const r = await migrate(['migrate', 'down', '2']);
    expect(r.code).toBe(0);
    expect(r.runs[0]).toMatchObject({ direction: 'down', count: 2 });
  });

  it('exits 1 naming both roles when connected as another role, before anything else', async () => {
    const r = await migrate(['migrate', 'up'], {
      role: { name: 'drefyn_app', superuser: false, bypassRls: false },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('drefyn_owner');
    expect(r.stderr).toContain('drefyn_app');
    expect(r.calls).toEqual(['role', 'close']);
  });

  it.each([
    [{ name: 'drefyn_owner', superuser: true, bypassRls: false }, 'superuser'],
    [{ name: 'drefyn_owner', superuser: false, bypassRls: true }, 'BYPASSRLS'],
  ])('refuses an owner that can skip row level security (%j)', async (role, word) => {
    const r = await migrate(['migrate', 'up'], { role });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(word);
    expect(r.calls).not.toContain('lock');
  });

  it.each([['up'], ['down'], ['status']])(
    'exits 4 on %s before the lock when vector is missing',
    async (command) => {
      const r = await migrate(['migrate', command], { vector: undefined });
      expect(r.code).toBe(4);
      expect(r.stderr).toMatch(/not installed/);
      expect(r.calls).toEqual(['role', 'prerequisites', 'close']);
    },
  );

  it.each([['up'], ['down'], ['status']])(
    'exits 4 on %s before the lock when drefyn_auth is missing, naming the upgrade',
    async (command) => {
      const r = await migrate(['migrate', command], {
        roles: [{ role: 'drefyn_auth', exists: false, canConnect: false }],
      });
      expect(r.code).toBe(4);
      expect(r.stderr).toContain('drefyn_auth');
      expect(r.stderr).toContain('bash scripts/selfhost.sh upgrade');
      expect(r.stderr).toContain('deploy/postgres/upgrade/0001-auth-role.sql');
      expect(r.calls).toEqual(['role', 'prerequisites', 'roles', 'close']);
    },
  );

  it('exits 4 when drefyn_auth may not connect to this database', async () => {
    const r = await migrate(['migrate', 'up'], {
      roles: [{ role: 'drefyn_auth', exists: true, canConnect: false }],
    });
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('CONNECT');
    expect(r.calls).not.toContain('lock');
  });

  it('exits 2 and touches nothing when the lock is held', async () => {
    const r = await migrate(['migrate', 'up'], { lockFree: false });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/another run holds the migration lock/);
    // Never held, so never released.
    expect(r.calls).toEqual(['role', 'prerequisites', 'roles', 'indexes', 'lock', 'close']);
  });

  it('exits 1 on a tracking table of the wrong shape and creates nothing', async () => {
    const r = await migrate(['migrate', 'down'], {
      trackingProblem: 'app.pgmigrations.run_on is timestamp without time zone',
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('run_on');
    expect(r.calls).not.toContain('bookkeeping');
    expect(r.calls.slice(-2)).toEqual(['unlock', 'close']);
  });

  it('exits 3 naming every changed, missing and unrecorded file, before any DDL', async () => {
    const dir = folder();
    const recorded = await hashes(dir);
    const r = await migrate(
      ['migrate', 'up'],
      {
        history: [
          { name: '1760000000001_a', sha256: 'f'.repeat(64) },
          { name: '1760000000002_b', sha256: undefined },
          { name: '1760000000000_gone', sha256: recorded['1760000000001_a'] },
        ],
      },
      dir,
    );
    expect(r.code).toBe(3);
    expect(r.stderr).toContain(`${A} changed after it ran`);
    expect(r.stderr).toContain(`${B} ran with no recorded checksum`);
    expect(r.stderr).toContain('1760000000000_gone.sql ran but is not in');
    expect(r.stderr).toContain('README');
    expect(r.calls).not.toContain('bookkeeping');
    expect(r.calls).not.toContain('run up');
    expect(r.calls).toContain('unlock');
  });

  it('releases the lock and exits 1 when the run fails', async () => {
    const r = await migrate(['migrate', 'up'], { runError: new Error('division by zero') });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('division by zero');
    expect(r.calls.slice(-2)).toEqual(['unlock', 'close']);
  });

  it('keeps the run error when releasing the lock fails too', async () => {
    const r = await migrate(['migrate', 'up'], {
      runError: new Error('division by zero'),
      unlockError: new Error('connection terminated'),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/warning: could not release the lock: connection terminated/);
    expect(r.stderr).toContain('division by zero');
  });

  it('warns but still succeeds when closing the connection fails', async () => {
    const r = await migrate(['migrate', 'up'], { closeError: new Error('already closed') });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/warning: could not close the connection: already closed/);
  });
});

// An invalid index in app means a concurrent build failed or is still running; a marked file
// that skipped it through if not exists would otherwise be recorded on top of it.
describe('runMigrate with an invalid index in app', () => {
  const invalid: InvalidIndex[] = [
    { index: 'widgets_name_key', table: 'widgets', building: false },
    { index: 'gadgets_name_idx_ccnew', table: 'gadgets', building: true },
  ];

  it.each([['up'], ['down'], ['status']])(
    'exits 4 on %s before the lock, naming each',
    async (command) => {
      const r = await migrate(['migrate', command], { invalid });
      expect(r.code).toBe(4);
      expect(r.stderr).toContain('app.widgets_name_key on app.widgets');
      expect(r.stderr).toContain(
        'app.gadgets_name_idx_ccnew on app.gadgets (a build is still in progress)',
      );
      expect(r.stderr).toContain('drop index concurrently if exists app.<index>');
      expect(r.calls).toEqual(['role', 'prerequisites', 'roles', 'indexes', 'close']);
    },
  );

  it('checks the vector extension first', async () => {
    const r = await migrate(['migrate', 'up'], { invalid, vector: undefined });
    expect(r.code).toBe(4);
    expect(r.calls).not.toContain('indexes');
  });
});

describe('runMigrate status', () => {
  it('lists applied and pending files, and never locks or creates anything', async () => {
    const dir = folder();
    const recorded = await hashes(dir);
    const r = await migrate(
      ['migrate', 'status'],
      { history: [{ name: '1760000000001_a', sha256: recorded['1760000000001_a'] }] },
      dir,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`applied  ${A}\npending  ${B}\n`);
    expect(r.calls).toEqual([
      'role',
      'prerequisites',
      'roles',
      'indexes',
      'shape',
      'history',
      'close',
    ]);
  });

  it('marks each problem file in the report and exits 3', async () => {
    const r = await migrate(['migrate', 'status'], {
      history: [{ name: '1760000000001_a', sha256: 'f'.repeat(64) }],
    });
    expect(r.code).toBe(3);
    expect(r.stdout).toBe(`changed  ${A}\npending  ${B}\n`);
    expect(r.stderr).toContain(A);
  });

  it('exits 1 on a tracking table of the wrong shape', async () => {
    const r = await migrate(['migrate', 'status'], { trackingProblem: 'run_on is text' });
    expect(r.code).toBe(1);
    expect(r.calls).not.toContain('history');
  });
});

describe('runMigrate errors', () => {
  it('prints the code of an error with no message', async () => {
    const error = Object.assign(new Error(''), { code: 'ECONNRESET' });
    const r = await migrate(['migrate', 'up'], { runError: error });
    expect(r.stderr).toContain('drefyn migrate: ECONNRESET');
  });

  it('prints the name of an error with neither', async () => {
    const r = await migrate(['migrate', 'up'], { runError: new TypeError('') });
    expect(r.stderr).toContain('drefyn migrate: TypeError');
  });

  // A library that throws a bare string still ends in exit 1 with a line, not a crash.
  it('survives a thrown value that is not an Error', async () => {
    const stderr = capture();
    const code = await runMigrate({
      argv: ['migrate', 'up', '--migrations-dir', folder()],
      env: ENV,
      stdout: capture(),
      stderr,
      connect: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the case under test
        throw 'boom';
      },
    });
    expect(code).toBe(1);
    expect(stderr.text()).toContain('drefyn migrate: unknown error');
  });
});
