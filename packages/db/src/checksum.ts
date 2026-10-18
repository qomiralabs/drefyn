import { notImplemented } from './not-implemented.ts';

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
  return notImplemented('sha256Hex', contents);
}

// Every applied migration must still be on disk with the hash recorded when it ran.
export function verifyChecksums(
  recorded: readonly RecordedMigration[],
  onDisk: readonly MigrationOnDisk[],
): ChecksumProblem[] {
  return notImplemented('verifyChecksums', recorded, onDisk);
}
