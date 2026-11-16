export const GIT_SYNC_STORE_ERROR_CODES = Object.freeze([
  'git_sync.disabled',
  'git_sync.not_entitled',
  'git_sync.busy',
  'git_sync.input_invalid',
  'git_sync.folder_unsafe',
  'git_sync.path_outside_folder',
  'git_sync.too_many_files',
  'git_sync.binding_exists',
  'git_sync.binding_not_found',
  'git_sync.binding_inactive',
] as const);

export type GitSyncStoreErrorCode = (typeof GIT_SYNC_STORE_ERROR_CODES)[number];
