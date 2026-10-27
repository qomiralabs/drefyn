/// <reference types="vite/client" />
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(cleanup);

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Story {
  name?: string;
  tags?: string[];
  render?: () => ReactNode;
}

const modules = import.meta.glob<Record<string, unknown>>('../../stories/*.stories.tsx', {
  eager: true,
});

const storiesOf = (file: string): Record<string, Story> => {
  const module = modules[`../../stories/${file}.stories.tsx`];
  if (module === undefined) throw new Error(`no stories/${file}.stories.tsx`);
  return Object.fromEntries(
    Object.entries(module).filter(([name]) => name !== 'default'),
  ) as Record<string, Story>;
};

// One story per state that applies. Success and error are not button states (the result is
// shown where the change happened), so Button has none; a menu is never empty.
const REQUIRED: Record<string, string[]> = {
  button: [
    'Actions',
    'BecomesBusy',
    'Busy',
    'Disabled',
    'Links',
    'Primary',
    'Quiet',
    'Secondary',
    'Sizes',
    'WithIcon',
  ],
  badge: ['OnFill', 'OnRaised', 'States'],
  'status-pip': ['States'],
  'status-dot': ['Live', 'States'],
  skeleton: ['LoadingRows', 'LoadingText', 'Shapes'],
  'empty-state': ['ErrorState', 'FirstUse', 'NoResults', 'OverLimit'],
  icons: ['All'],
  switch: ['Disabled', 'Off', 'On', 'Settings'],
  menu: ['Default', 'IconTrigger', 'InARow', 'Open', 'Sections'],
};

// Stories that show a disabled or busy control. The browser paint check opens each and
// fails if it shows none, and fails on any untagged story that shows one.
const DISABLED: Record<string, string[]> = {
  button: ['Disabled'],
  switch: ['Disabled'],
  menu: ['Open'],
};

// Stories that show a busy button at rest. Busy keeps its variant's paint, so it is checked
// apart from disabled.
const BUSY: Record<string, string[]> = {
  button: ['Busy'],
};

describe('the component stories', () => {
  for (const [file, names] of Object.entries(REQUIRED)) {
    it(`${file} has a story for every state that applies`, () => {
      expect(Object.keys(storiesOf(file)).sort()).toEqual([...names].sort());
    });

    it(`${file} tags exactly its disabled stories`, () => {
      const tagged = Object.entries(storiesOf(file))
        .filter(([, story]) => story.tags?.includes('disabled') === true)
        .map(([name]) => name)
        .sort();
      expect(tagged).toEqual(DISABLED[file] ?? []);
    });

    it(`${file} tags exactly its busy stories`, () => {
      const tagged = Object.entries(storiesOf(file))
        .filter(([, story]) => story.tags?.includes('busy') === true)
        .map(([name]) => name)
        .sort();
      expect(tagged).toEqual(BUSY[file] ?? []);
    });

    it(`${file} renders every story`, () => {
      for (const [name, story] of Object.entries(storiesOf(file))) {
        expect(story.render, name).toBeTypeOf('function');
        const { container } = render(<>{story.render?.()}</>);
        expect(container.childElementCount, name).toBeGreaterThan(0);
        cleanup();
      }
    });
  }

  it('covers every stories file in the package', () => {
    const files = readdirSync(join(root, 'stories'))
      .filter((f) => f.endsWith('.stories.tsx'))
      .map((f) => f.replace(/\.stories\.tsx$/, ''))
      .filter((f) => f !== 'foundations')
      .sort();
    expect(files).toEqual(Object.keys(REQUIRED).sort());
  });

  it('never draws a spinner or a looping animation, in stories or components', () => {
    const dirs = [
      join(root, 'stories'),
      join(root, 'src', 'react'),
      join(root, 'src', 'react', 'icons'),
    ];
    const hits: string[] = [];
    for (const dir of dirs) {
      for (const file of readdirSync(dir).filter((f) => /\.tsx?$/.test(f))) {
        const text = readFileSync(join(dir, file), 'utf8');
        for (const match of text.matchAll(/\banimate-[a-z-]+|\bspin\b|role="progressbar"/g)) {
          hits.push(`${file}: ${match[0]}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
