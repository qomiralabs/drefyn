// The migrate command as a function. The drefyn binary lives in @drefyn/cli, which can
// import both db and auth; db cannot import auth.
export { USAGE as MIGRATE_USAGE } from './args.ts';
export { runMigrate } from './run.ts';
