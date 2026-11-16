import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { readerPage } from '../src/reader.ts';
import type { Dialect, ReaderPage, RenderPolicy } from '../src/index.ts';
import { parsed, policy } from './helpers.ts';
import { rendered } from './render-helpers.ts';

type Node = DefaultTreeAdapterMap['node'];

// Text a browser shows, from the markup the render makes. Joined with nothing, as inline
// elements join, so a reader word that spans no tag is always found inside it.
export function shownText(html: string): string {
  let text = '';
  const pending: Node[] = [parseFragment(html)];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.nodeName === '#text' && 'value' in node) text += node.value;
    if ('childNodes' in node) pending.push(...[...node.childNodes].reverse());
  }
  return text;
}

export const readerWords = (page: ReaderPage): readonly string[] =>
  page.state === 'ok'
    ? page.units.flatMap(({ heading, text }) =>
        `${heading?.text ?? ''} ${text}`.split(/\s+/).filter((word) => word !== ''),
      )
    : [];

// Words the reader text holds that the render does not show.
export function unseenWords(source: string, dialect: Dialect, use: RenderPolicy = policy()) {
  const page = readerPage(parsed(source, dialect, use), use);
  const shown = shownText(rendered(source, dialect, use));
  return readerWords(page).filter((word) => !shown.includes(word));
}
