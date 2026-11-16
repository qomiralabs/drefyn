import { describe, expect, it } from 'vitest';
import * as gitSync from '../src/index.ts';

describe('the package entry', () => {
  it('exposes the store, the queue rules and the reconcile', () => {
    expect(Object.keys(gitSync).sort()).toEqual(
      [
        'BINDING_STATES',
        'DEFAULT_CLAIM_DEADLINE_MS',
        'DEFAULT_MAX_FILES',
        'DEFAULT_RECONCILE_MAX_TENANTS',
        'DELIVERY_STATES',
        'FOLDER_MAX_CHARS',
        'GIT_SYNC_FEATURE',
        'GIT_SYNC_FLAG',
        'GIT_SYNC_STORE_ERROR_CODES',
        'MAX_QUEUED_PER_BINDING',
        'PATH_MAX_CHARS',
        'RECONCILE_INTERVAL_MS',
        'bindingLockKey',
        'coalesce',
        'createGitSyncGate',
        'createGitSyncStore',
        'databaseGitSyncDb',
        'isBranchName',
        'isPathInFolder',
        'newestFirst',
        'noopLogger',
        'parseFolder',
        'parseGitSyncConfig',
        'reconcileDeliveryId',
        'reconcileOnce',
        'startReconcile',
      ].sort(),
    );
    expect(() => {
      gitSync.noopLogger.info('x', {});
      gitSync.noopLogger.warn('x', {});
    }).not.toThrow();
  });

  it('names the flag and plan feature the gate reads', () => {
    expect(gitSync.GIT_SYNC_FLAG).toBe('docs.git_sync');
    expect(gitSync.GIT_SYNC_FEATURE).toBe('docs.git_editing');
  });
});
