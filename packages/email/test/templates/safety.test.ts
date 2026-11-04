import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderMail } from '../../src/index.ts';
import { PREVIEW_MESSAGES } from '../fixtures/messages.ts';
import { ORIGIN } from '../support.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? files(full) : [full];
  });
}

const sources = [...files(join(root, 'src/templates')), ...files(join(root, 'src/html'))];
// The two namespaces Word needs. Nothing fetches them.
const NAMESPACES = ['http://www.w3.org/1999/xhtml'];

describe('template sources', () => {
  it('finds the templates', () => {
    expect(sources.length).toBeGreaterThanOrEqual(6);
  });

  it.each(sources.map((file) => [relative(root, file), file]))('%s stays safe', (_name, file) => {
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('@drefyn/ui/react');
    expect(text).not.toContain('dangerouslySetInnerHTML');
    expect(text).not.toContain('<img');
    expect(text).not.toContain('<script');
    expect(text).not.toContain('@font-face');
    expect(text).not.toContain('url(');
    for (const match of text.matchAll(/https?:\/\/[^\s"'`]+/g)) {
      expect(NAMESPACES).toContain(match[0]);
    }
  });

  it('never reads the subtle text token, so the faintest text is secondary', () => {
    for (const file of sources) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\.subtle\b/);
    }
  });

  it('keeps templates synchronous, so static rendering never drops a suspended part', () => {
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/\basync\b|\bawait\b|\bSuspense\b|\blazy\(/);
    }
  });
});

describe('rendered mail', () => {
  it.each(PREVIEW_MESSAGES)('%s fetches nothing and links only to the app', async (_n, message) => {
    const result = await renderMail(message, { linkOrigin: ORIGIN });
    if (!result.ok) throw new Error(result.error.code);
    const { html, text } = result.value;
    for (const tag of ['<img', '<script', '<svg', '<link', '<iframe', '<form', '<video']) {
      expect(html).not.toContain(tag);
    }
    expect(html).not.toContain('@font-face');
    expect(html).not.toContain('url(');
    expect(html).not.toContain('@import');
    // Each tag the renderer fills in is gone, and each comment left is one of its own.
    expect(html).not.toMatch(/<mso-|<\/mso-/);
    for (const comment of html.matchAll(/<!--(.*?)-->/gs)) {
      expect(comment[1]).toMatch(/^\[if mso\]|^\[if !mso\]|<!\[endif\]$/);
    }
    for (const href of html.matchAll(/ href="([^"]*)"/g)) {
      expect(new URL(href[1] ?? '').origin).toBe(ORIGIN.origin);
    }
    for (const raw of text.match(/https?:\/\/\S+/g) ?? []) {
      expect(new URL(raw).origin).toBe(ORIGIN.origin);
    }
  });

  it('never lets a hostile name become markup', async () => {
    for (const [name, message] of PREVIEW_MESSAGES.filter(([n]) => n.startsWith('hostile.'))) {
      const result = await renderMail(message, { linkOrigin: ORIGIN });
      if (!result.ok) throw new Error(result.error.code);
      expect(result.value.html, name).toContain('&lt;');
      expect(result.value.html, name).not.toContain('onerror=alert(1)>');
    }
  });

  it('holds every style inline, so a client that strips the head loses nothing', async () => {
    for (const [name, message] of PREVIEW_MESSAGES) {
      const result = await renderMail(message, { linkOrigin: ORIGIN });
      if (!result.ok) throw new Error(result.error.code);
      const stripped = result.value.html.replace(/<style[\s\S]*?<\/style>/g, '');
      for (const tag of stripped.matchAll(/<(h1|p|a|th|td)\b[^>]*class="[^"]*"[^>]*>/g)) {
        expect(tag[0], name).toContain('style="');
      }
    }
  });
});
