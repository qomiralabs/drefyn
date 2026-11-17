# `@drefyn/git-sync`

Git sync binds one GitHub repository, branch and folder to a Docs project. This package holds
the binding, the map from file paths to page nodes, the queue of push deliveries and the
hourly reconcile. Reading trees and blobs, saving drafts and committing back build on it.

Open core: nothing here calls GitHub or a hosted service. The host passes in a database, a
gate and, for the reconcile, the projects to visit.

## Public API

Everything other packages may use is exported from `src/index.ts`.

- `createGitSyncStore({ db, gate, logger?, clock?, maxFiles? })` returns the store.
  `databaseGitSyncDb(db)` adapts a `@drefyn/db` database. Every call checks the gate first
  and returns `git_sync.disabled` or `git_sync.not_entitled` without touching the database.
  - `createBinding(tenant, input)`: one binding per project. A folder with a leading or
    trailing `/`, an empty, `.` or `..` segment, a backslash or a control character is refused
    with `git_sync.folder_unsafe`; `''` is the repository root. A second binding returns
    `git_sync.binding_exists`.
  - `getBinding(tenant)` and `pauseBinding(tenant, bindingId, code)`. The code is stable, such
    as `git.unauthorized`, so the dashboard can explain it.
  - `listFiles` and `upsertFiles`: the file map in path order. Paths must sit inside the
    folder. Over `maxFiles` (default 2000, `DREFYN_GIT_SYNC_MAX_FILES`) both refuse with
    `git_sync.too_many_files` rather than cut the map short.
  - `enqueueDelivery(tenant, { bindingId, deliveryId, headSha })`: stored once per delivery
    id, even after it ran. Past 100 queued for one binding the oldest are finished at once.
  - `claimDelivery(tenant, bindingId, work)`: takes the binding's advisory lock, runs `work`
    on the newest queued delivery and marks the older ones done unread. A second worker gets
    `git_sync.busy`. A paused binding returns `git_sync.binding_inactive`. If `work` throws,
    everything rolls back and the deliveries stay queued.
- `createGitSyncGate({ flags, entitlements, logger })`: the `docs.git_sync` release flag and
  the `docs.git_editing` plan feature. A read that fails refuses.
- `reconcileOnce({ store, tenants, clock?, logger?, maxTenants? })` queues one delivery per
  active binding with the id `reconcile:<binding>:<hour>`, so every server can run it and
  each binding still gets one per hour. `startReconcile` runs it every hour.
- `parseFolder`, `isPathInFolder`, `isBranchName`, `coalesce` and `bindingLockKey` are the
  pure rules the store applies.

## Why the queue coalesces

A worker reads the branch head when it runs, not the commit a push named. So older queued
pushes add nothing once a newer one is due, and redelivered or reordered webhooks land in the
same state.

## Tests

- `pnpm --filter @drefyn/git-sync test`: unit and property tests.
- `pnpm --filter @drefyn/git-sync test:integration`: against the compose Postgres, with
  `COMPOSE_PROJECT_NAME` set. Holds `src/store.ts` to 95 percent line coverage.
- `pnpm --filter @drefyn/git-sync bench`: claim p95 with 10,000 queued deliveries across
  1,000 tenants. Budget 10 ms.
