import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blobOid } from './oid.ts';

// Real git never sends a malformed batch, so a fake child replays crafted output to
// prove the parser fails closed on every way the stream could be wrong.
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new Writable({
    write: (_chunk, _encoding, callback) => {
      callback();
    },
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

// Real oids, since the reader hashes every body and rejects one that does not match.
const BODY_A = 'one\n';
const BODY_B = '';
const BODY_C = 'three';
const A = blobOid(BODY_A);
const B = blobOid(BODY_B);
const C = blobOid(BODY_C);
const SECRET = 'SECRET54 token=hunter2';

function record(oid: string, body: string): string {
  return `${oid} blob ${Buffer.byteLength(body)}\n${body}\n`;
}

function replyWith(text: string): void {
  reply = Buffer.from(text, 'utf8');
}

async function failure(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

beforeEach(() => {
  spawn.mockClear();
  reply = Buffer.alloc(0);
});

describe('readBlobs parses cat-file output strictly', () => {
  it('returns every requested blob when the output is well formed', async () => {
    replyWith(record(A, BODY_A) + record(B, BODY_B) + record(C, BODY_C));
    const blobs = await readBlobs('/repo', [A, B, C], 'sha1');
    expect([...blobs.keys()]).toEqual([A, B, C]);
    expect(blobs.get(A)?.toString()).toBe('one\n');
    expect(blobs.get(B)?.length).toBe(0);
    expect(blobs.get(C)?.toString()).toBe('three');
  });

  it('accepts the same oid requested twice, as two paths with identical content give', async () => {
    replyWith(record(A, BODY_A) + record(A, BODY_A));
    const blobs = await readBlobs('/repo', [A, A], 'sha1');
    expect(blobs.get(A)?.toString()).toBe(BODY_A);
  });

  it('does not spawn git when nothing is requested', async () => {
    expect((await readBlobs('/repo', [], 'sha1')).size).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects a header with no newline', async () => {
    replyWith(`${A} blob 3`);
    await expect(readBlobs('/repo', [A], 'sha1')).rejects.toThrow(
      `git cat-file header for ${A} has no newline`,
    );
  });

  // 99999999999999999999 passes the digit pattern but is not a safe integer, so it
  // must fail as a bad size, not as a body cut short.
  it.each(['-1', '1.5', 'abc', '', '1e2', '+3', '0x3', '99999999999999999999'])(
    'rejects the size %j',
    async (size) => {
      replyWith(`${A} blob ${size}\nabc\n`);
      await expect(readBlobs('/repo', [A], 'sha1')).rejects.toThrow(
        `git cat-file gave an invalid size for ${A}`,
      );
    },
  );

  it('rejects a header with extra fields', async () => {
    replyWith(`${A} blob 3 extra\nabc\n`);
    await expect(readBlobs('/repo', [A], 'sha1')).rejects.toThrow(/malformed header/);
  });

  it.each([
    ['the oid alone', `${A}\n`],
    ['no size', `${A} blob\n`],
  ])('rejects a header with %s as malformed', async (_name, text) => {
    replyWith(text);
    await expect(readBlobs('/repo', [A], 'sha1')).rejects.toThrow(
      `git cat-file gave a malformed header for ${A}`,
    );
  });

  it('rejects a missing object reply', async () => {
    replyWith(`${A} missing\n`);
    await expect(readBlobs('/repo', [A], 'sha1')).rejects.toThrow(
      `git cat-file reports ${A} missing`,
    );
  });

  it('rejects an object that is not a blob', async () => {
    replyWith(`${A} tree 3\nabc\n`);
    await expect(readBlobs('/repo', [A], 'sha1')).rejects.toThrow(
      `git cat-file returned tree for ${A}`,
    );
  });

  it('rejects a body shorter than its declared size', async () => {
    replyWith(`${A} blob 10\nabc\n`);
    await expect(readBlobs('/repo', [A], 'sha1')).rejects.toThrow(
      `git cat-file body for ${A} is truncated`,
    );
  });

  it('rejects a body that is not followed by a newline', async () => {
    replyWith(`${A} blob 3\nabcX${record(B, BODY_B)}`);
    await expect(readBlobs('/repo', [A, B], 'sha1')).rejects.toThrow(
      `git cat-file body for ${A} is not followed by a newline`,
    );
  });

  it('rejects a final body with no terminator at all', async () => {
    replyWith(`${A} blob 3\nabc`);
    await expect(readBlobs('/repo', [A], 'sha1')).rejects.toThrow(
      `git cat-file body for ${A} is not followed by a newline`,
    );
  });

  it('rejects swapped oids', async () => {
    replyWith(record(B, BODY_B) + record(A, BODY_A));
    await expect(readBlobs('/repo', [A, B], 'sha1')).rejects.toThrow(
      `git cat-file returned ${B} where ${A} was requested`,
    );
  });

  it('rejects an oid that was never requested', async () => {
    replyWith(record(A, BODY_A) + record(C, BODY_C));
    await expect(readBlobs('/repo', [A, B], 'sha1')).rejects.toThrow(
      `git cat-file returned ${C} where ${B} was requested`,
    );
  });

  it('rejects one record for a duplicate request instead of counting the oid once', async () => {
    replyWith(record(A, BODY_A));
    await expect(readBlobs('/repo', [A, A], 'sha1')).rejects.toThrow(
      'git cat-file returned 1 of 2 requested objects',
    );
  });

  it('rejects fewer records than requested', async () => {
    replyWith(record(A, BODY_A));
    await expect(readBlobs('/repo', [A, B], 'sha1')).rejects.toThrow(
      'git cat-file returned 1 of 2 requested objects',
    );
  });

  it('rejects more records than requested', async () => {
    replyWith(record(A, BODY_A) + record(B, BODY_B));
    await expect(readBlobs('/repo', [A], 'sha1')).rejects.toThrow(
      'git cat-file returned more objects than the 1 requested',
    );
  });

  // Each cut must fail with the message for where it lands, so a cut that fails for the
  // wrong reason, or with an error from outside the parser, fails the test.
  it('rejects every truncation of a valid batch with the message for that cut', async () => {
    const bodies: [string, string][] = [
      [A, BODY_A],
      [B, BODY_B],
      [C, BODY_C],
    ];
    const full = bodies.map(([oid, body]) => record(oid, body)).join('');
    const expected: string[] = [];
    let offset = 0;
    for (const [index, [oid, body]] of bodies.entries()) {
      const bodyStart = offset + `${oid} blob ${body.length}\n`.length;
      const bodyEnd = bodyStart + body.length;
      expected[offset] = `git cat-file returned ${index} of 3 requested objects`;
      for (let cut = offset + 1; cut < bodyStart; cut += 1) {
        expected[cut] = `git cat-file header for ${oid} has no newline`;
      }
      for (let cut = bodyStart; cut < bodyEnd; cut += 1) {
        expected[cut] = `git cat-file body for ${oid} is truncated`;
      }
      expected[bodyEnd] = `git cat-file body for ${oid} is not followed by a newline`;
      offset = bodyEnd + 1;
    }
    expect(offset).toBe(full.length);
    for (let length = 0; length < full.length; length += 1) {
      replyWith(full.slice(0, length));
      expect(await failure(readBlobs('/repo', [A, B, C], 'sha1')), `cut at ${length}`).toBe(
        expected[length],
      );
    }
  });
});

describe('readBlobs checks every body against its oid', () => {
  it('rejects a body that was changed under its oid', async () => {
    replyWith(record(A, 'two\n'));
    await expect(readBlobs('/repo', [A], 'sha1')).rejects.toThrow(
      `git cat-file body for ${A} does not match its oid`,
    );
  });

  // What a replace ref does: the header keeps the oid that was asked for.
  it("rejects one oid answered with another blob's body", async () => {
    replyWith(`${A} blob ${BODY_C.length}\n${BODY_C}\n`);
    await expect(readBlobs('/repo', [A], 'sha1')).rejects.toThrow(
      `git cat-file body for ${A} does not match its oid`,
    );
  });

  it('rejects a duplicate request answered with two different bodies', async () => {
    replyWith(record(A, BODY_A) + `${A} blob 5\ndirty\n`);
    await expect(readBlobs('/repo', [A, A], 'sha1')).rejects.toThrow(
      `git cat-file body for ${A} does not match its oid`,
    );
  });

  it('hashes with sha256 in a sha256 repository', async () => {
    const oid = blobOid(BODY_A, 'sha256');
    replyWith(record(oid, BODY_A));
    const blobs = await readBlobs('/repo', [oid], 'sha256');
    expect(blobs.get(oid)?.toString()).toBe(BODY_A);
  });

  it('rejects a sha256 oid whose body does not match', async () => {
    const oid = blobOid(BODY_A, 'sha256');
    replyWith(record(oid, BODY_C));
    await expect(readBlobs('/repo', [oid], 'sha256')).rejects.toThrow(
      `git cat-file body for ${oid} does not match its oid`,
    );
  });

  it('does not hash with sha1 in a sha256 repository', async () => {
    replyWith(record(A, BODY_A));
    await expect(readBlobs('/repo', [A], 'sha256')).rejects.toThrow(/does not match its oid/);
  });
});

// Blob content can hold secrets and is printed to CI logs, so no error may carry any
// byte of it, wherever in the stream that byte sits.
describe('readBlobs errors never echo content', () => {
  it.each([
    ['a body that does not match', `${A} blob ${SECRET.length}\n${SECRET}\n`],
    ['junk in place of a header', `${SECRET}\n`],
    ['junk in the oid field', `${SECRET.replace(' ', '')} blob 3\nabc\n`],
    ['junk in the type field', `${A} ${SECRET.replace(' ', '')} 3\nabc\n`],
    ['junk in the size field', `${A} blob ${SECRET.replace(' ', '')}\nabc\n`],
  ])('%s', async (_name, text) => {
    replyWith(text);
    const message = await failure(readBlobs('/repo', [A], 'sha1'));
    expect(message).toMatch(/^git cat-file /);
    expect(message).not.toContain('SECRET54');
    expect(message).not.toContain('hunter2');
  });
});
