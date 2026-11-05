import { describe, expect, it } from 'vitest';
import { loadSiteConfig } from '../src/index.ts';

describe('loadSiteConfig', () => {
  it('defaults to 14000', () => {
    expect(loadSiteConfig({})).toEqual({ ok: true, value: { maxFirstResponseBytes: 14_000 } });
  });

  it('reads a value', () => {
    expect(loadSiteConfig({ DREFYN_SITE_MAX_FIRST_RESPONSE_BYTES: '12000' })).toEqual({
      ok: true,
      value: { maxFirstResponseBytes: 12_000 },
    });
  });

  it.each(['', '0', '-1', '1.5', '14KB', '16001', '1e4'])('refuses %j', (value) => {
    expect(loadSiteConfig({ DREFYN_SITE_MAX_FIRST_RESPONSE_BYTES: value })).toEqual({
      ok: false,
      error: { code: 'site.config_invalid', key: 'DREFYN_SITE_MAX_FIRST_RESPONSE_BYTES' },
    });
  });
});
