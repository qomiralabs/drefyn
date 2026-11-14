// The only static import. ESM reads and links a module's whole static graph before running any
// of it, so a parent read in a module imported beside the parser is read only once the parser has
// loaded, and a parent that dies in that time leaves this host running for good. What is left is
// Node's own start, before this line runs, which nothing in the host can see.
import {
  PARENT_GONE_EXIT_CODE,
  PARENT_GONE_LINE,
  stopThenKill,
  watchParent,
} from './parent-watch.ts';

let running = false;

// Same stop as SIGTERM. Under a live parent this never runs, and with none left nothing else
// would stop this process or enforce the stop.
watchParent(() => {
  process.exitCode = PARENT_GONE_EXIT_CODE;
  if (!running) {
    // Nothing to close yet, and no SIGTERM handler to take the stop.
    process.stdout.write(PARENT_GONE_LINE);
    process.exit();
  }
  stopThenKill(
    () => {
      process.kill(process.pid, 'SIGTERM');
    },
    () => {
      process.kill(process.pid, 'SIGKILL');
    },
  );
  // After the stop is armed: a write to a closed pipe can end this process.
  process.stdout.write(PARENT_GONE_LINE);
});

const { runHost } = await import('./host-run.ts');
runHost();
running = true;
