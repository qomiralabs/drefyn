'use client';
import { createContext, useContext, useLayoutEffect, useRef, type RefObject } from 'react';

// React Aria takes a disabled radio or tab out of arrow key navigation. Ours stay
// reachable, so React Aria is never told they are disabled; each one registers its value
// here instead, and the group refuses to choose any value in the set.
export type Unavailable = RefObject<Set<string>>;

export const UnavailableContext = createContext<Unavailable | null>(null);

export function useUnavailableSet(): Unavailable {
  return useRef(new Set<string>());
}

export function useUnavailable(value: string, unavailable: boolean): void {
  const set = useContext(UnavailableContext);
  useLayoutEffect(() => {
    if (set === null || !unavailable) return;
    // The set lives for the group's lifetime, so the one read here is the one to clean.
    const values = set.current;
    values.add(value);
    return () => {
      values.delete(value);
    };
  }, [set, value, unavailable]);
}
