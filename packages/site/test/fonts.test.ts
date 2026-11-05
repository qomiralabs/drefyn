import { Window } from 'happy-dom';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderDocsPage, renderStatusPage } from '../src/index.ts';
import { pageInput } from './fixtures.ts';

const figures = createElement(
  'main',
  { className: 'page' },
  createElement('time', { dateTime: '2026-11-05' }, '14:02'),
  createElement('span', { 'data-numeric': true }, '99.98%'),
);

const data = { pages: new Map([['/', { title: 'A', description: 'B', body: figures }]]) };

function built(render: typeof renderStatusPage, locale = 'en') {
  const result = render(pageInput({ locale }, data));
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

describe('status fonts', () => {
  it('loads no font and asks no other host for anything', () => {
    const { html, assets } = built(renderStatusPage);
    expect(assets).toEqual([]);
    expect(html).not.toMatch(/@font-face|url\(|woff|https?:|<link/);
  });

  it('shows tabular figures in computed style', () => {
    const { html } = built(renderStatusPage);
    const window = new Window();
    window.document.write(html);
    for (const selector of ['time', '[data-numeric]']) {
      const element = window.document.querySelector(selector);
      if (element === null) throw new Error(selector);
      expect(window.getComputedStyle(element).fontVariantNumeric).toBe('tabular-nums');
    }
    void window.happyDOM.abort();
  });
});

describe('docs fonts', () => {
  it.each(['en', 'de', 'zh-CN', 'ja', 'ar'])('loads at most 3 files in %s', (locale) => {
    const { assets, html } = built(renderDocsPage, locale);
    expect(assets).toEqual([
      { kind: 'font', href: '/fonts/inter-latin-400-normal.woff2' },
      { kind: 'font', href: '/fonts/inter-latin-600-normal.woff2' },
      { kind: 'font', href: '/fonts/jetbrains-mono-latin-400-normal.woff2' },
    ]);
    expect(html.match(/url\(/g)).toHaveLength(3);
    expect(html).toContain(`<html lang="${locale}">`);
  });
});
