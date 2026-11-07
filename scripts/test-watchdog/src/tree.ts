import { execFileSync } from 'node:child_process';

export interface Seen {
  readonly pid: number;
  readonly command: string;
}

function table() {
  const rows = execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' });
  return rows.split('\n').flatMap((row) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(row);
    if (match === null) return [];
    const [, pid = '', ppid = '', command = ''] = match;
    return [{ pid: Number(pid), ppid: Number(ppid), command }];
  });
}

export function descendants(root: number): readonly Seen[] {
  const rows = table();
  const found: Seen[] = [];
  const walk = (parent: number) => {
    for (const { pid, ppid, command } of rows) {
      if (ppid !== parent) continue;
      found.push({ pid, command });
      walk(pid);
    }
  };
  walk(root);
  return found.filter(({ command }) => !command.startsWith('ps '));
}

// By pid and command, so a reused pid or a zombie waiting on its reaper is not counted.
export function stillRunning(seen: readonly Seen[]): readonly Seen[] {
  const rows = new Map(table().map(({ pid, command }) => [pid, command]));
  return seen.filter(({ pid, command }) => rows.get(pid) === command);
}

export function sweep(seen: readonly Seen[]): void {
  for (const { pid } of stillRunning(seen)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // It ended between the look and the kill.
    }
  }
}
