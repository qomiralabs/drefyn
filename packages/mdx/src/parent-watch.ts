export const PARENT_CHECK_MS = 1_000;
export const PARENT_GONE_GRACE_MS = 5_000;
// A lost parent is never a clean stop: whatever ran this process died without stopping it. So the
// stop logs at error and exits non zero. 69 sits outside the 1 to 14 Node uses for its own
// failures and the 128 and up of a signal, so an alert can tell it from a crash or a kill.
export const PARENT_GONE_EXIT_CODE = 69;
export const PARENT_GONE_LINE = `${JSON.stringify({ level: 'error', event: 'mdx.parse_host_parent_gone' })}\n`;

// Read as this module loads. A parent that dies before the first read cannot be told from a
// process that started under init, so the earlier the better.
const parentAtStart = process.ppid;

export interface ParentWatchOptions {
  readonly parent?: number;
  readonly ppid?: () => number;
}

// Nothing runs in a process killed outright, so its children have to notice for themselves.
// A dead parent's children are adopted, by init or a subreaper, so the parent pid changes.
// Compared with the pid at start, never with 1: PID 1 in a container reads 0 for good, and a
// child of init reads 1 for good. Both are live parents. This reads one number and needs no
// permission, and a stdin pipe would not do, since the image gives the supervisor /dev/null.
export function watchParent(onGone: () => void, options: ParentWatchOptions = {}): () => void {
  const { parent = parentAtStart, ppid = () => process.ppid } = options;
  const timer = setInterval(() => {
    if (ppid() === parent) return;
    clearInterval(timer);
    onGone();
  }, PARENT_CHECK_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}

// Armed first: a stop can hang on a thread stuck in native code, and no supervisor is left to
// send the SIGKILL a stop relies on.
export function stopThenKill(stop: () => void, kill: () => void): void {
  setTimeout(kill, PARENT_GONE_GRACE_MS).unref();
  stop();
}
