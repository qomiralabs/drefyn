import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Real git never sends a malformed batch, so a fake child replays crafted output to
// prove the parser fails closed on every way the stream could be wrong.
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new Writable({
    write: (_chunk, _encoding, callback) => callback(),
  });

  constructor(output: Buffer) {
    super();
    this.stdin.on('finish', () => {
      this.stdout.end(output);
      this.stderr.end();
      setImmediate(() => this.emit('close', 0));
    });
  }
}

let reply = Buffer.alloc(0);
const spawn = vi.fn(() => new FakeChild(reply));

vi.mock('node:child_process', () => ({ spawn }));

const { readBlobs } = await import('../src/git.ts');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

function record(oid: string, body: string): string {
  return `${oid} blob ${Buffer.byteLength(body)}\n${body}\n`;
}

function replyWith(text: string): void {
  reply = Buffer.from(text, 'utf8');
}

beforeEach(() => {
  spawn.mockClear();
  reply = Buffer.alloc(0);
});

describe('readBlobs parses cat-file output strictly', () => {
  it('returns every requested blob when the output is well formed', async () => {
    replyWith(record(A, 'one\n') + record(B, '') + record(C, 'three'));
    const blobs = await readBlobs('/repo', [A, B, C]);
    expect([...blobs.keys()]).toEqual([A, B, C]);
    expect(blobs.get(A)?.toString()).toBe('one\n');
    expect(blobs.get(B)?.length).toBe(0);
    expect(blobs.get(C)?.toString()).toBe('three');
  });

  it('accepts the same oid requested twice, as two paths with identical content give', async () => {
    replyWith(record(A, 'same') + record(A, 'same'));
    const blobs = await readBlobs('/repo', [A, A]);
    expect(blobs.get(A)?.toString()).toBe('same');
  });

  it('does not spawn git when nothing is requested', async () => {
    expect((await readBlobs('/repo', [])).size).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects a header with no newline', async () => {
    replyWith(`${A} blob 3`);
    await expect(readBlobs('/repo', [A])).rejects.toThrow(
      `git cat-file header for ${A} has no newline`,
    );
  });

  it.each(['-1', '1.5', 'abc', '', '1e2', '+3', '0x3'])('rejects the size %j', async (size) => {
    replyWith(`${A} blob ${size}\nabc\n`);
    await expect(readBlobs('/repo', [A])).rejects.toThrow(
      `git cat-file gave an invalid size for ${A}`,
    );
  });

  it('rejects a header with extra fields', async () => {
    replyWith(`${A} blob 3 extra\nabc\n`);
    await expect(readBlobs('/repo', [A])).rejects.toThrow(/malformed header/);
  });

  it('rejects a missing object reply', async () => {
    replyWith(`${A} missing\n`);
    await expect(readBlobs('/repo', [A])).rejects.toThrow(`git cat-file reports ${A} missing`);
  });

  it('rejects an object that is not a blob', async () => {
    replyWith(`${A} tree 3\nabc\n`);
    await expect(readBlobs('/repo', [A])).rejects.toThrow(`git cat-file returned tree for ${A}`);
  });

  it('rejects a body shorter than its declared size', async () => {
    replyWith(`${A} blob 10\nabc\n`);
    await expect(readBlobs('/repo', [A])).rejects.toThrow(
      `git cat-file body for ${A} is truncated`,
    );
  });

  it('rejects a body that is not followed by a newline', async () => {
    replyWith(`${A} blob 3\nabcX${record(B, 'b')}`);
    await expect(readBlobs('/repo', [A, B])).rejects.toThrow(
      `git cat-file body for ${A} is not followed by a newline`,
    );
  });

  it('rejects a final body with no terminator at all', async () => {
    replyWith(`${A} blob 3\nabc`);
    await expect(readBlobs('/repo', [A])).rejects.toThrow(
      `git cat-file body for ${A} is not followed by a newline`,
    );
  });

  it('rejects swapped oids', async () => {
    replyWith(record(B, 'b') + record(A, 'a'));
    await expect(readBlobs('/repo', [A, B])).rejects.toThrow(
      `git cat-file returned ${B} where ${A} was requested`,
    );
  });

  it('rejects an oid that was never requested', async () => {
    replyWith(record(A, 'a') + record(C, 'c'));
    await expect(readBlobs('/repo', [A, B])).rejects.toThrow(
      `git cat-file returned ${C} where ${B} was requested`,
    );
  });

  it('rejects fewer records than requested', async () => {
    replyWith(record(A, 'a'));
    await expect(readBlobs('/repo', [A, B])).rejects.toThrow(
      'git cat-file returned 1 of 2 requested objects',
    );
  });

  it('rejects more records than requested', async () => {
    replyWith(record(A, 'a') + record(B, 'b'));
    await expect(readBlobs('/repo', [A])).rejects.toThrow(
      'git cat-file returned more objects than the 1 requested',
    );
  });

  it('rejects every truncation of a valid batch', async () => {
    const full = record(A, 'first\n') + record(B, '') + record(C, 'third line');
    for (let length = 0; length < full.length; length += 1) {
      replyWith(full.slice(0, length));
      await expect(readBlobs('/repo', [A, B, C]), `truncated to ${length}`).rejects.toThrow(
        /git cat-file/,
      );
    }
  });
});
