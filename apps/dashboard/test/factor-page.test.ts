import { describe, expect, it } from 'vitest';
import { codesPage, drawQr, enrolPage, escapeHtml, FACTOR_CSS } from '../src/server/factor-page.ts';
import { FACTOR_STATES } from '../src/server/factor-gallery.ts';

const DASHES = new RegExp(`[${String.fromCodePoint(0x2013, 0x2014)}]`);
const URI =
  'otpauth://totp/Drefyn:maya%40acme.dev?secret=AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH&issuer=Drefyn';

describe('drawQr', () => {
  it('draws one path in module units, the same every time', () => {
    const one = drawQr(URI);
    expect(one.size).toBeGreaterThanOrEqual(21);
    expect(one.path).toMatch(/^M[\d LZM]+$/);
    expect(drawQr(URI)).toEqual(one);
  });

  // The longest address the spike measured still fits a version a phone can read.
  it('stays within reach for a long address', () => {
    const long = `otpauth://totp/Drefyn:${'a'.repeat(240)}%40acme.dev?secret=${'A'.repeat(32)}&issuer=Drefyn`;
    expect(drawQr(long).size).toBeLessThanOrEqual(97);
  });
});

describe('escapeHtml', () => {
  it('escapes the five characters that matter', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});

describe('the pages', () => {
  const pages = Object.entries(FACTOR_STATES).map(([name, draw]) => [name, draw()] as const);

  it.each(pages)(
    '%s holds no script, inline style, hidden field or framework payload',
    (_n, body) => {
      expect(body).toMatch(/^<!doctype html>/);
      expect(body).not.toMatch(/<script|__next_f|\sstyle=|<style|type="hidden"/i);
      expect(body).toContain('<link rel="stylesheet" href="/auth/factor-style">');
      expect(body).toContain('<html lang="en">');
      expect(body).not.toMatch(DASHES);
    },
  );

  it('draws the QR as an image with a name, and never the URI as text', () => {
    const body = enrolPage({ otpauthUri: URI, manualKey: 'AAAA BBBB', mistyped: false });
    expect(body).toContain('role="img"');
    expect(body).toContain('<title id="qr-name">QR code for your authenticator app</title>');
    expect(body).not.toContain('otpauth');
    expect(body).not.toContain('aria-invalid');
  });

  // With scripts off the confirm form posts the code alone.
  it('posts only the code to confirm', () => {
    const body = enrolPage({ otpauthUri: URI, manualKey: 'AAAA BBBB', mistyped: false });
    expect(body.match(/<input /g)).toHaveLength(1);
    expect(body).toContain('action="/account/second-factor/confirm"');
    expect(body).toContain('name="code"');
  });

  it('points the field at the error after a mistyped code, and gives it focus', () => {
    const body = enrolPage({ otpauthUri: URI, manualKey: 'AAAA BBBB', mistyped: true });
    expect(body).toContain('aria-describedby="code-hint code-error"');
    expect(body).toContain('aria-invalid="true"');
    expect(body).toMatch(/<input [^>]*autofocus/);
  });

  it('lists every recovery code, escaped, and offers no second way to get them', () => {
    const body = codesPage({ recoveryCodes: ['a<b', 'c'], reason: 'enrolled' });
    expect(body).toContain('<li><code>a&lt;b</code></li>');
    expect(body).not.toMatch(/download|<form/i);
    expect(body).toContain('API keys keep working');
  });
});

describe('the stylesheet', () => {
  // Only tokens: no colour, size or timing written out.
  it('uses token values only', () => {
    expect(FACTOR_CSS).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|\d+px|\d+ms/i);
  });

  it('keeps the QR dark on light in both themes and honours reduced motion', () => {
    expect(FACTOR_CSS).toContain('prefers-color-scheme: dark');
    expect(FACTOR_CSS).toContain('prefers-reduced-motion: reduce');
  });
});
