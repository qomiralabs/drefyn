import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { serialize } from '../src/index.ts';
import { codes, issuesOf, parsed } from './helpers.ts';

const CANARY = 'canary-3f9a1c';
const FIELD = 'drefynPwned';

const hostile = [
  'export const leaked = process.env.DREFYN_TEST_CANARY',
  `export const ran = (globalThis.${FIELD} = 1)`,
  '',
  `<Box a={globalThis.${FIELD} = 2} {...(globalThis.${FIELD} = 3)}>{globalThis.${FIELD} = 4}</Box>`,
  '',
  `Inline {globalThis.${FIELD} = 5} expression`,
  '',
].join('\n');

afterEach(() => {
  delete process.env['DREFYN_TEST_CANARY'];
  Reflect.deleteProperty(globalThis, FIELD);
});

describe('ESM and expressions', () => {
  it('round trip byte for byte and never run', () => {
    process.env['DREFYN_TEST_CANARY'] = CANARY;
    const ast = parsed(hostile, 'mdx');
    const output = serialize(ast);
    expect(output).toBe(hostile);
    expect(output).not.toContain(CANARY);
    expect(JSON.stringify(ast)).not.toContain(CANARY);
    expect(FIELD in globalThis).toBe(false);
  });

  it('warn that they stay inert', () => {
    const found = codes(issuesOf(hostile, 'mdx'));
    expect(found).toContain('mdx.esm_inert');
    expect(found).toContain('mdx.expression_inert');
  });

  it('keep nothing executable beyond the authored text', () => {
    expect(JSON.stringify(parsed(hostile, 'mdx'))).not.toContain('estree');
  });

  it('are never read through an evaluating package', () => {
    const manifest = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    expect(manifest).not.toContain('@mdx-js');
  });
});
