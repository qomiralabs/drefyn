import { describe, expect, it, vi } from 'vitest';
import {
  createFixtureFeed,
  FIXTURE_INCIDENT,
  incidentRouteExists,
  START_ITEM,
  type FeedStorage,
} from '../src/incident/feed.ts';

function fakeStorage(): FeedStorage & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function fakeWindow() {
  const listeners = new Set<(event: { key: string | null }) => void>();
  return {
    listeners,
    addEventListener: (_: 'storage', fn: (event: { key: string | null }) => void) => {
      listeners.add(fn);
    },
    removeEventListener: (_: 'storage', fn: (event: { key: string | null }) => void) => {
      listeners.delete(fn);
    },
    fire: (key: string | null) => {
      for (const fn of listeners) fn({ key });
    },
  };
}

describe('the fixture incident feed', () => {
  it('starts with nothing open', () => {
    expect(createFixtureFeed('acme', fakeStorage(), fakeWindow()).current()).toBeNull();
  });

  it('opens and resolves, telling each listener once', () => {
    const feed = createFixtureFeed('acme', fakeStorage(), fakeWindow());
    const heard = vi.fn();
    feed.subscribe(heard);
    feed.start();
    expect(feed.current()).toBe(FIXTURE_INCIDENT);
    expect(heard).toHaveBeenCalledTimes(1);
    feed.start();
    expect(heard).toHaveBeenCalledTimes(1);
    feed.resolve();
    expect(feed.current()).toBeNull();
    expect(heard).toHaveBeenCalledTimes(2);
    feed.resolve();
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('survives a reload and stays inside its organization', () => {
    const storage = fakeStorage();
    createFixtureFeed('acme', storage, fakeWindow()).start();
    expect(createFixtureFeed('acme', storage, fakeWindow()).current()).toBe(FIXTURE_INCIDENT);
    expect(createFixtureFeed('globex', storage, fakeWindow()).current()).toBeNull();
  });

  it('hears a change made in another tab, and only for its own key', () => {
    const storage = fakeStorage();
    const win = fakeWindow();
    const feed = createFixtureFeed('acme', storage, win);
    const heard = vi.fn();
    const stop = feed.subscribe(heard);
    createFixtureFeed('acme', storage, fakeWindow()).start();
    win.fire('dr-theme');
    expect(heard).not.toHaveBeenCalled();
    win.fire([...storage.values.keys()][0] ?? '');
    expect(heard).toHaveBeenCalledTimes(1);
    expect(feed.current()).toBe(FIXTURE_INCIDENT);
    storage.values.clear();
    win.fire(null);
    expect(heard).toHaveBeenCalledTimes(2);
    expect(feed.current()).toBeNull();
    stop();
    expect(win.listeners.size).toBe(0);
  });

  it('keeps working when storage is refused', () => {
    const feed = createFixtureFeed(
      'acme',
      {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
        removeItem: () => {
          throw new Error('denied');
        },
      },
      fakeWindow(),
    );
    expect(feed.current()).toBeNull();
    feed.start();
    expect(feed.current()).toBe(FIXTURE_INCIDENT);
    feed.resolve();
    expect(feed.current()).toBeNull();
  });
});

describe('incident routes', () => {
  it('exist for the known incident and for starting one, on the incident project', () => {
    const { project, id } = FIXTURE_INCIDENT;
    expect(incidentRouteExists('status', project, id)).toBe(true);
    expect(incidentRouteExists('status', project, START_ITEM)).toBe(true);
  });

  it.each([
    ['docs', FIXTURE_INCIDENT.project, FIXTURE_INCIDENT.id, 'another product'],
    ['status', 'other', FIXTURE_INCIDENT.id, 'another project'],
    ['status', FIXTURE_INCIDENT.project, 'inc-unknown', 'an unknown incident'],
  ])('do not exist for %s %s %s (%s)', (product, project, item) => {
    expect(incidentRouteExists(product, project, item)).toBe(false);
  });
});
