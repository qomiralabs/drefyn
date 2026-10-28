import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';

const policy = {
  allow: ['MIT'],
  exceptions: [{ name: 'caniuse-lite', license: 'CC-BY-4.0', reason: 'Ships with Next.' }],
  forbidden: [],
};
const report = {
  MIT: [{ name: 'left-pad', versions: ['1.0.0'], license: 'MIT' }],
  'CC-BY-4.0': [{ name: 'caniuse-lite', versions: ['1.0.0'], license: 'CC-BY-4.0' }],
};

describe('license-policy --notices', () => {
  let dir: string;
  let out: string;
  let err: string;
  const io = {
    out: (text: string) => {
      out += text;
    },
    err: (text: string) => {
      err += text;
    },
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'license-notices-'));
    out = '';
    err = '';
    writeFileSync(join(dir, 'all.json'), JSON.stringify(report));
    writeFileSync(join(dir, 'prod.json'), JSON.stringify(report));
    writeFileSync(join(dir, 'policy.json'), JSON.stringify(policy));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (notices: string) => {
    writeFileSync(join(dir, 'NOTICES.md'), notices);
    return main(
      [
        '--input',
        join(dir, 'all.json'),
        '--policy',
        join(dir, 'policy.json'),
        '--prod-input',
        join(dir, 'prod.json'),
        '--notices',
        join(dir, 'NOTICES.md'),
      ],
      io,
    );
  };

  it('passes when every shipped exception has its notice', () => {
    expect(run('## caniuse-lite\n\nLicence: CC-BY-4.0\n')).toBe(0);
    expect(out).toContain('notices: 1 shipped exception, 0 missing\n');
    expect(err).toBe('');
  });

  it('fails and names the package when its notice is missing', () => {
    expect(run('# Third party notices\n')).toBe(1);
    expect(err).toBe('caniuse-lite: ships under CC-BY-4.0 with no entry in NOTICES.md\n');
  });

  it('needs the production listing to know what ships', () => {
    const code = main(['--input', join(dir, 'all.json'), '--notices', join(dir, 'NOTICES.md')], io);
    expect(code).toBe(2);
    expect(err).toContain('--notices needs --prod-input');
  });
});
