import { describe, inject } from 'vitest';
import { run } from './process.ts';
import { composeFile } from './stack.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    // Why the compose stack cannot be used on this machine, or null when it can.
    stackAbsent: string | null;
  }
}

export function inCi(env: NodeJS.ProcessEnv): boolean {
  const value = env['CI'] ?? '';
  return value !== '' && value !== 'false' && value !== '0';
}

// The one rule for every integration file: run when the stack is there; on a laptop
// without it, skip with the reason in the suite name; in CI, fail the run with the reason.
export function stackRule(absent: string | null, env: NodeJS.ProcessEnv): 'run' | 'skip' | 'fail' {
  if (absent === null) return 'run';
  return inCi(env) ? 'fail' : 'skip';
}

// Why the compose stack cannot be used on this machine, or null when it can.
export async function stackAbsence(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const project = env['COMPOSE_PROJECT_NAME'] ?? '';
  if (project === '') return 'COMPOSE_PROJECT_NAME is not set';
  const result = await run(
    'docker',
    ['compose', '-p', project, '-f', composeFile, 'ps', '--status', 'running', '--services'],
    { env: { ...env, COMPOSE_PROJECT_NAME: project } },
  ).catch(() => null);
  if (result?.code !== 0) {
    return `docker compose cannot reach project ${project}`;
  }
  if (!result.stdout.split('\n').includes('postgres')) {
    return `compose project ${project} has no running postgres`;
  }
  return null;
}

// A describe block that runs against the stack, or is skipped with the reason in its name.
export function describeWithStack(name: string, body: () => void): void {
  const absent = inject('stackAbsent');
  if (absent === null) describe(name, body);
  else describe.skip(`${name} [skipped, no compose stack: ${absent}]`, body);
}
