import { describe, expect, it } from 'vitest';
import { DEFAULT_DOCS_URL, docsUrl } from '../src/server/docs-url.ts';

describe('docsUrl', () => {
  it('points at our docs when nothing is configured', () => {
    expect(docsUrl({})).toBe(DEFAULT_DOCS_URL);
    expect(docsUrl({ DREFYN_DOCS_URL: '' })).toBe(DEFAULT_DOCS_URL);
  });

  it('reads the configured URL as given', () => {
    expect(docsUrl({ DREFYN_DOCS_URL: 'https://docs.acme.dev/drefyn' })).toBe(
      'https://docs.acme.dev/drefyn',
    );
    expect(docsUrl({ DREFYN_DOCS_URL: 'http://127.0.0.1:4000' })).toBe('http://127.0.0.1:4000');
  });

  it.each(['docs.acme.dev', 'javascript:alert(1)', 'ftp://docs.acme.dev', 'not a url'])(
    'refuses %s, naming the key and not the value',
    (value) => {
      expect(() => docsUrl({ DREFYN_DOCS_URL: value })).toThrow(
        /^DREFYN_DOCS_URL is not an http or https URL$/,
      );
    },
  );

  it('reads the process environment by default', () => {
    const before = process.env['DREFYN_DOCS_URL'];
    process.env['DREFYN_DOCS_URL'] = 'https://docs.example.dev';
    try {
      expect(docsUrl()).toBe('https://docs.example.dev');
    } finally {
      if (before === undefined) delete process.env['DREFYN_DOCS_URL'];
      else process.env['DREFYN_DOCS_URL'] = before;
    }
  });
});
