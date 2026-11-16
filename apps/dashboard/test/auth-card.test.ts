import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AUTH_CARD, cardName, type CardContent } from '../src/auth/card.ts';
import { AuthCard } from '../src/auth/card-view.tsx';

const draw = (content: CardContent) => renderToStaticMarkup(createElement(AuthCard, { content }));

const QUOTE: CardContent = {
  kind: 'quote',
  quote: 'We moved our docs and status page in an afternoon.',
  name: 'Priya Shah',
  handle: '@priya',
  avatar: '/avatars/priya.png',
};

describe('the signed out card', () => {
  it('ships the product line and no quote until real ones exist', () => {
    expect(AUTH_CARD).toEqual({
      kind: 'line',
      line: 'Publish your docs, content and status page from one place.',
      support: 'Open source, on one account and one plan.',
    });
    const html = draw(AUTH_CARD);
    expect(html).toMatch(/^<aside class="auth-card" aria-label="About Drefyn">/);
    expect(html).toContain('Publish your docs, content and status page from one place.');
    expect(html).toContain('Open source, on one account and one plan.');
    expect(html).not.toContain('<blockquote');
  });

  it('renders a quote with name, handle and avatar from the same slot', () => {
    const html = draw(QUOTE);
    expect(html).toMatch(
      /^<aside class="auth-card" aria-label="What Priya Shah says about Drefyn">/,
    );
    expect(html).toContain('<blockquote class="auth-card-line"><p>We moved our docs');
    expect(html).toContain('<span class="auth-card-name">Priya Shah</span>');
    expect(html).toContain('<span class="auth-card-handle">@priya</span>');
    expect(html).toContain(
      '<img src="/avatars/priya.png" alt="" width="32" height="32" loading="lazy"/>',
    );
  });

  it('holds nothing focusable unless it is given a link', () => {
    for (const content of [AUTH_CARD, QUOTE]) {
      expect(draw(content)).not.toMatch(/<(a|button|input|select|textarea)[\s>]|tabindex/);
    }
    const link = { href: 'https://drefyn.com/customers', label: 'Read the story' };
    for (const content of [
      { ...AUTH_CARD, link },
      { ...QUOTE, link },
    ]) {
      const html = draw(content);
      expect(html.match(/<a /g)).toHaveLength(1);
      expect(html).toContain(
        '<a class="auth-card-link" href="https://drefyn.com/customers">Read the story</a>',
      );
    }
  });

  it('names itself after what it holds', () => {
    expect(cardName(AUTH_CARD)).toBe('About Drefyn');
    expect(cardName(QUOTE)).toBe('What Priya Shah says about Drefyn');
  });
});
