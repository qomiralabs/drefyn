export const SEED_MARKER = 'DREFYN_E2E_SEED';
const MARKER_VALUE = 'real-stack-e2e';
// The per job name in dashboard.yml, so an operator's stack can never match by default.
const TEST_STACK = /^drefyn-dash-\d+-\d+-\d+$/;

// The seed migrates as the owner, adds verified owners as the superuser and writes live
// cookies to disk. An accident guard, not a privilege boundary: it takes shell access to run
// at all, but on a real install that is exactly what an operator has.
export function refuseOutsideTests(env: Readonly<Record<string, string | undefined>>): void {
  const marked = env[SEED_MARKER] === MARKER_VALUE;
  const testStack = TEST_STACK.test(env['COMPOSE_PROJECT_NAME'] ?? '');
  if (marked && testStack && env['NODE_ENV'] !== 'production') return;
  throw new Error('seed:e2e refuses to run outside a test stack');
}
