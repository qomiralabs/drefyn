import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/tokens/cli.ts';
import { generatedFiles } from '../src/tokens/generate.ts';

let dir: string;
let out: string[];
let err: string[];
const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'drefyn-tokens-'));
  out = [];
  err = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('tokens cli', () => {
  it('writes every generated file', () => {
    expect(main(['--out', dir], io)).toBe(0);
    for (const [name, content] of Object.entries(generatedFiles())) {
      expect(readFileSync(join(dir, name), 'utf8')).toBe(content);
    }
    expect(out.join('')).toMatch(/wrote 4 files/);
  });

  it('--check passes on fresh output and names the stale file otherwise', () => {
    main(['--out', dir], io);
    expect(main(['--out', dir, '--check'], io)).toBe(0);
    writeFileSync(join(dir, 'tokens.css'), ':root{}');
    rmSync(join(dir, 'tailwind.css'));
    expect(main(['--out', dir, '--check'], io)).toBe(1);
    expect(err.join('')).toMatch(/tokens\.css is out of date/);
    expect(err.join('')).toMatch(/tailwind\.css is missing/);
  });

  it('rejects unknown arguments', () => {
    expect(main(['--nope'], io)).toBe(2);
    expect(err.join('')).toMatch(/usage/);
  });
});
