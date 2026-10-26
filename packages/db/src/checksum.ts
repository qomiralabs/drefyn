import { createHash } from 'node:crypto';

export interface RecordedMigration {
  readonly name: string;
  // Undefined when the tool recorded the run but no checksum was stored for it.
  readonly sha256: string | undefined;
}

export interface MigrationOnDisk {
  readonly name: string;
  readonly sha256: string;
}

export type ChecksumProblem =
  | {
      readonly kind: 'changed';
      readonly name: string;
      readonly recorded: string;
      readonly actual: string;
    }
  | { readonly kind: 'missing'; readonly name: string }
  | { readonly kind: 'unrecorded'; readonly name: string };

export function sha256Hex(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}

// Every applied migration must still be on disk with the hash recorded when it ran.
export function verifyChecksums(
  recorded: readonly RecordedMigration[],
  onDisk: readonly MigrationOnDisk[],
): ChecksumProblem[] {
  const disk = new Map(onDisk.map((file) => [file.name, file.sha256]));
  const problems: ChecksumProblem[] = [];
  for (const { name, sha256 } of recorded) {
    const actual = disk.get(name);
    if (actual === undefined) problems.push({ kind: 'missing', name });
    else if (sha256 === undefined) problems.push({ kind: 'unrecorded', name });
    else if (sha256 !== actual) problems.push({ kind: 'changed', name, recorded: sha256, actual });
  }
  return problems;
}
