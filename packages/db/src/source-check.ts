import { notImplemented } from './not-implemented.ts';

export interface SourceProblem {
  readonly file: string;
  readonly line: number;
  // The offending statement or call, trimmed to one line.
  readonly statement: string;
  readonly message: string;
}

// Migration DDL whose target is an extension or schema extensions.
export function extensionDdlProblems(file: string, sql: string): readonly SourceProblem[] {
  return notImplemented(`extensionDdlProblems(${file}, ${String(sql.length)})`);
}

export function migrationDirProblems(dir: string): readonly SourceProblem[] {
  return notImplemented(`migrationDirProblems(${dir})`);
}

// Session scoped tenant settings: set drefyn.* and set_config(..., false).
export function sessionSettingProblems(file: string, text: string): readonly SourceProblem[] {
  return notImplemented(`sessionSettingProblems(${file}, ${String(text.length)})`);
}

// Every tracked text file in the repository, except the reviewed fixture folders.
export function repoSourceProblems(root: string): readonly SourceProblem[] {
  return notImplemented(`repoSourceProblems(${root})`);
}

export interface CheckSourcesIo {
  readonly argv: readonly string[];
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

export function runCheckSources(io: CheckSourcesIo): number {
  return notImplemented(`runCheckSources(${typeof io})`);
}
