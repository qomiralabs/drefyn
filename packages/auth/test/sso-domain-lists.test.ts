import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  FREE_MAIL_DOMAINS,
  bundledPublicSuffixListPath,
  createSsoDomainPolicy,
  loadFreeMailDomains,
  loadPublicSuffixList,
  normalizeSsoDomain,
  parseFreeMailDomains,
  parsePublicSuffixList,
} from '../src/index.ts';
import { expectAuthError } from './support.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../..');
const listDir = join(here, '../data/public-suffix-list');
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

const scratch = mkdtempSync(join(tmpdir(), 'drefyn-free-mail-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function fileWith(text: string | Buffer): string {
  const path = join(scratch, `list-${String(Math.random()).slice(2)}.txt`);
  writeFileSync(path, text);
  return path;
}

describe('the bundled Public Suffix List', () => {
  // ASSETS.md is the record of where the file came from and under what terms.
  const assets = readFileSync(join(repoRoot, 'ASSETS.md'), 'utf8');
  const section = assets.split('\n## ').find((s) => s.startsWith('Public Suffix List'));

  it('is the file ASSETS.md records, byte for byte, with its licence beside it', () => {
    expect(section).toBeDefined();
    for (const file of ['public_suffix_list.dat', 'MPL-2.0.txt']) {
      const row = section?.split('\n').find((line) => line.includes(`\`${file}\``));
      expect(row, file).toBeDefined();
      expect(row).toContain(sha256(join(listDir, file)));
    }
    expect(section).toContain('https://publicsuffix.org/list/public_suffix_list.dat');
    expect(section).toContain('MPL-2.0');
  });

  it('still carries the MPL notice and the source address in its header', () => {
    const head = readFileSync(join(listDir, 'public_suffix_list.dat'), 'utf8').slice(0, 600);
    expect(head).toContain('This Source Code Form is subject to the terms of the Mozilla Public');
    expect(head).toContain('https://mozilla.org/MPL/2.0/');
    expect(head).toContain('https://publicsuffix.org/list/public_suffix_list.dat');
    expect(readFileSync(join(listDir, 'MPL-2.0.txt'), 'utf8')).toContain(
      'Mozilla Public License Version 2.0',
    );
  });

  it('is found at the path the loader reads', () => {
    expect(bundledPublicSuffixListPath()).toBe(join(listDir, 'public_suffix_list.dat'));
  });

  it('loads into thousands of rules that answer for known names', async () => {
    const list = await loadPublicSuffixList();
    expect(list.size).toBeGreaterThan(9000);
    for (const suffix of [
      'com',
      'co.uk',
      'github.io',
      'xn--55qx5d.cn',
      'kawasaki.jp',
      'x.kawasaki.jp',
    ]) {
      expect(list.isPublicSuffix(suffix), suffix).toBe(true);
    }
    for (const name of ['acme.com', 'acme.co.uk', 'city.kawasaki.jp', 'www.ck', 'acme.github.io']) {
      expect(list.isPublicSuffix(name), name).toBe(false);
    }
  });
});

describe('parsePublicSuffixList', () => {
  it('reads rules, wildcards and exceptions and skips comments and blank lines', () => {
    const list = parsePublicSuffixList(
      [
        '// comment',
        '',
        'test',
        '*.wild.test',
        '!keep.wild.test',
        '  spaced.test  trailing words',
        '',
      ].join('\r\n'),
    );
    expect(list.size).toBe(4);
    expect(list.isPublicSuffix('test')).toBe(true);
    expect(list.isPublicSuffix('wild.test')).toBe(false);
    expect(list.isPublicSuffix('any.wild.test')).toBe(true);
    expect(list.isPublicSuffix('keep.wild.test')).toBe(false);
    expect(list.isPublicSuffix('deep.any.wild.test')).toBe(false);
    expect(list.isPublicSuffix('spaced.test')).toBe(true);
  });

  it('refuses an empty list, so a broken file cannot turn the check off', () => {
    expectAuthError(() => parsePublicSuffixList('// nothing\n'), 'AUTH_CONFIG_INVALID');
  });

  it('refuses a rule it cannot read rather than skipping it', () => {
    expectAuthError(() => parsePublicSuffixList('com\nfoo.*.bar\n'), 'AUTH_CONFIG_INVALID');
    expectAuthError(() => parsePublicSuffixList('com\n!\n'), 'AUTH_CONFIG_INVALID');
    expectAuthError(() => parsePublicSuffixList('com\nbad_label.x\n'), 'AUTH_CONFIG_INVALID');
  });
});

describe('free mail domains', () => {
  it('builds in the common providers', () => {
    for (const domain of [
      'gmail.com',
      'googlemail.com',
      'outlook.com',
      'hotmail.com',
      'yahoo.com',
      'icloud.com',
      'proton.me',
      'gmx.de',
      'qq.com',
      'yandex.ru',
    ]) {
      expect(FREE_MAIL_DOMAINS, domain).toContain(domain);
    }
    // Each entry is already in the stored form, so a lookup can compare as is.
    for (const domain of FREE_MAIL_DOMAINS) expect(normalizeSsoDomain(domain)).toBe(domain);
    expect(new Set(FREE_MAIL_DOMAINS).size).toBe(FREE_MAIL_DOMAINS.length);
  });

  it('reads one domain a line, with comments, blank lines and any spelling', () => {
    expect(
      parseFreeMailDomains(
        '# extra\n\nMail.Corp.Test\n  bücher.test.  # a comment\r\nmail.corp.test\n',
      ),
    ).toEqual(['mail.corp.test', 'xn--bcher-kva.test']);
  });

  it('refuses a line that is not a domain, naming the key and never the line', () => {
    expectAuthError(
      () => parseFreeMailDomains('ok.test\nnot a domain\n'),
      'AUTH_CONFIG_INVALID',
      'DREFYN_AUTH_SSO_FREE_MAIL_DOMAINS_FILE',
    );
    try {
      parseFreeMailDomains('secret-value.test\n@@@\n');
    } catch (error) {
      expect(String(error)).not.toContain('@@@');
    }
  });

  it('loads the extra file and refuses one that is missing, binary or too large', async () => {
    expect(await loadFreeMailDomains(fileWith('extra.test\n'))).toEqual(['extra.test']);
    await expect(loadFreeMailDomains(join(scratch, 'missing.txt'))).rejects.toMatchObject({
      code: 'AUTH_CONFIG_INVALID',
      key: 'DREFYN_AUTH_SSO_FREE_MAIL_DOMAINS_FILE',
    });
    await expect(
      loadFreeMailDomains(fileWith(Buffer.from([0xff, 0xfe, 0x00]))),
    ).rejects.toMatchObject({
      code: 'AUTH_CONFIG_INVALID',
    });
    await expect(loadFreeMailDomains(fileWith('a.test\n'.repeat(200_000)))).rejects.toMatchObject({
      code: 'AUTH_CONFIG_INVALID',
    });
  });

  it('refuses the extra entries in the policy with the built in ones', () => {
    const policy = createSsoDomainPolicy({
      publicSuffixes: parsePublicSuffixList('test\ncom\n'),
      extraFreeMail: ['mail.corp.test'],
    });
    expect(policy.refusal('mail.corp.test')).toBe('free_mail');
    expect(policy.refusal('eu.mail.corp.test')).toBe('free_mail');
    expect(policy.refusal('gmail.com')).toBe('free_mail');
    expect(policy.refusal('corp.test')).toBeNull();
    expect(policy.refusal('test')).toBe('public_suffix');
  });
});
