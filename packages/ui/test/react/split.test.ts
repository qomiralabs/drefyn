// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import * as components from '../../src/react/index.ts';
import { barrelExports, checkSplit, isServerSafe, readTree } from './split.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = (name: string) => readTree(join(root, 'test', 'fixtures', 'split', name), '.txt');
const details = (name: string) => checkSplit(fixture(name)).map((f) => `${f.file}: ${f.detail}`);

// Props a server safe component needs to render; anything not listed renders with none.
const serverRenderProps: Record<string, Record<string, unknown>> = {
  Badge: { state: 'fresh', children: 'Verified 2 days ago' },
  Button: { children: 'Save draft' },
  ButtonLink: { href: '/history', children: 'View history' },
  EmptyState: { title: 'No components yet', children: 'Add one to start.' },
  StatusDot: { state: 'live', children: 'Syncing' },
  StatusPip: { state: 'fresh', label: 'Operational' },
  TextField: { id: 'site-name', label: 'Site name' },
};

function renderServerSafe(module: Record<string, unknown>): Map<string, string> {
  const rendered = new Map<string, string>();
  for (const [name, value] of Object.entries(module)) {
    if (!isServerSafe(name) || typeof value !== 'function') continue;
    const component = value as FunctionComponent<Record<string, unknown>>;
    rendered.set(name, renderToStaticMarkup(createElement(component, serverRenderProps[name])));
  }
  return rendered;
}

describe('the server and client split', () => {
  it('passes on src/react', () => {
    expect(checkSplit(readTree(join(root, 'src', 'react')))).toEqual([]);
  });

  it('fails on a hook call without the directive', () => {
    expect(details('hook-without-directive')).toEqual([
      "counter.tsx: calls useState without 'use client' as its first statement",
    ]);
  });

  it('fails on a react-aria-components import without the directive', () => {
    expect(details('aria-without-directive')).toEqual([
      "menu.tsx: imports react-aria-components without 'use client' as its first statement",
    ]);
  });

  it('fails on a server safe component that starts with the directive', () => {
    expect(details('server-safe-with-directive')).toEqual([
      "badge.tsx: exports Badge, which is server safe, but starts with 'use client'",
    ]);
  });

  it('fails on a hook called through the React namespace', () => {
    expect(details('member-hook-without-directive')).toEqual([
      "counter.tsx: calls useState without 'use client' as its first statement",
    ]);
  });

  it('fails on every React Aria and React Stately entry, not only the components package', () => {
    expect(details('client-imports-without-directive').sort()).toEqual([
      "focus.tsx: imports @react-aria/focus without 'use client' as its first statement",
      "hooks.tsx: imports react-aria without 'use client' as its first statement",
      "state.tsx: imports react-stately without 'use client' as its first statement",
      "utils.tsx: imports @react-stately/utils without 'use client' as its first statement",
    ]);
  });

  it('only counts the directive as the first statement', () => {
    expect(details('directive-not-first')).toEqual([
      "toggle.tsx: calls useState without 'use client' as its first statement",
    ]);
  });

  it('passes server safe, client and icon files, and names that only start with use', () => {
    expect(details('valid')).toEqual([]);
  });

  it('refuses a barrel that starts with the directive or re-exports with a star', () => {
    const tree = new Map([
      ['index.ts', "'use client';\nexport * from './badge.tsx';\n"],
      ['badge.tsx', 'export function Badge() { return <span>Fresh</span>; }\n'],
    ]);
    expect(checkSplit(tree).map((f) => f.detail)).toEqual([
      "the barrel must not start with 'use client'; every export would become a client component",
      "export * from './badge.tsx' hides which file each export comes from; name them",
    ]);
  });

  it('matches icon names by prefix and nothing else by accident', () => {
    expect(isServerSafe('IconCheck')).toBe(true);
    expect(isServerSafe('Badge')).toBe(true);
    expect(isServerSafe('BadgeGroup')).toBe(false);
    expect(isServerSafe('Menu')).toBe(false);
    expect(isServerSafe('TextField')).toBe(true);
    expect(isServerSafe('Tooltip')).toBe(false);
    expect(isServerSafe('toast')).toBe(false);
    expect(isServerSafe('Mark')).toBe(true);
    expect(isServerSafe('useLandmark')).toBe(false);
  });
});

describe('server safe components', () => {
  it('render to static markup in node', () => {
    function Badge({ children = 'Fresh' }: { children?: string }) {
      return createElement('span', null, children);
    }
    const IconCheck = () => createElement('svg', { 'aria-hidden': 'true' });
    const Menu = () => {
      throw new Error('a client component is never rendered here');
    };
    expect(Object.fromEntries(renderServerSafe({ Badge, IconCheck, Menu }))).toEqual({
      Badge: '<span>Verified 2 days ago</span>',
      IconCheck: '<svg aria-hidden="true"></svg>',
    });
  });

  it('covers every server safe export of @drefyn/ui/react without a list to update', () => {
    const { exports } = barrelExports(
      'index.ts',
      readFileSync(join(root, 'src', 'react', 'index.ts'), 'utf8'),
    );
    const serverSafe = [...exports.keys()].filter(isServerSafe).sort();
    const rendered = renderServerSafe(components);
    expect([...rendered.keys()].sort()).toEqual(serverSafe);
    for (const [name, markup] of rendered) expect(markup, name).not.toBe('');
  });
});
