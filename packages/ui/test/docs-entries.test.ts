import { describe, expect, it } from 'vitest';
import { storiesOnPage, type IndexRecord } from '../e2e/docs-entries.ts';

const entry = (id: string, type: string, title: string): IndexRecord => ({ id, type, title });

const INDEX: IndexRecord[] = [
  entry('components-dialog--docs', 'docs', 'Components/Dialog'),
  entry('components-dialog--default', 'story', 'Components/Dialog'),
  entry('components-dialog--open', 'story', 'Components/Dialog'),
  entry('components-dialog--failed', 'story', 'Components/Dialog'),
  entry('components-menu--docs', 'docs', 'Components/Menu'),
  entry('components-menu--default', 'story', 'Components/Menu'),
  entry('foundations--docs', 'docs', 'Foundations/Notes'),
];

// The ready wait expects one story block per story with the docs page's title, so the count
// it waits for comes from here.
describe('stories on a docs page', () => {
  it('counts the stories that share the docs page title', () => {
    expect(storiesOnPage(INDEX, 'Components/Dialog')).toBe(3);
    expect(storiesOnPage(INDEX, 'Components/Menu')).toBe(1);
  });

  it('counts no docs pages, only stories', () => {
    expect(storiesOnPage([entry('a--docs', 'docs', 'A')], 'A')).toBe(0);
  });

  it('is 0 for a page with no stories of its own', () => {
    expect(storiesOnPage(INDEX, 'Foundations/Notes')).toBe(0);
  });

  it('matches the title exactly, not by prefix', () => {
    expect(storiesOnPage(INDEX, 'Components/Dia')).toBe(0);
    expect(storiesOnPage(INDEX, 'Components')).toBe(0);
  });
});
