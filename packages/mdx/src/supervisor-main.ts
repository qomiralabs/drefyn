// The only static import, so the parent is read before the rest of the supervisor is even read
// from disk. ESM links a module's whole static graph before running any of it. What is left is
// Node's own start, before this line runs, which nothing in the supervisor can see.
import { PARENT_GONE_EXIT_CODE, PARENT_GONE_LINE, watchParent } from './parent-watch.ts';

let stop: (() => void) | undefined = undefined;

// As PID 1 in a container the parent reads 0 for good, so this only ever fires outside one.
watchParent(() => {
  process.exitCode = PARENT_GONE_EXIT_CODE;
  if (stop === undefined) {
    // Nothing started yet, so nothing to stop.
    process.stdout.write(PARENT_GONE_LINE);
    process.exit();
  }
  // The stop goes first: a log line to a closed pipe can end this process.
  stop();
  process.stdout.write(PARENT_GONE_LINE);
});

const { startSupervisor } = await import('./supervisor-run.ts');
const supervisor = startSupervisor();
stop = () => {
  supervisor.stop();
};
await supervisor.run();
// 0 unless a lost parent set one.
process.exit();
