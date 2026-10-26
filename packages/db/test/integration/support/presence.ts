import { describe, inject } from 'vitest';
import { run } from './process.ts';
import { composeFile } from './stack.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    // Why the compose stack cannot be used on this machine, or null when it can.
    stackAbsent: string | null;
  }
}

function inCi(env: NodeJS.ProcessEnv): boolean {
  const value = env['CI'] ?? '';
  return value !== '' && value !== 'false' && value !== '0';
}

// On a laptop without the stack, tests that opt in are skipped with this reason. In CI an
// absent stack is never a reason to skip: the global setup then fails the run instead.
export async function stackAbsence(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (inCi(env)) return null;
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
