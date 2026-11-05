'use client';
import { toast } from '@drefyn/ui/react';
import { useState, useSyncExternalStore } from 'react';
import { logWarn } from '../server/log.ts';
import { createOptimisticStore, type OptimisticStore } from './store.ts';

export interface Tenant {
  readonly organizationId: string;
  readonly projectId: string;
}

// One store for the life of the view. The first render of the props seeds it, because from
// then on the store, not the page, knows what the server holds.
export function useOptimistic<T extends { readonly id: string }>(
  initial: readonly T[],
  context: Tenant,
): readonly [readonly T[], OptimisticStore<T>] {
  const [store] = useState(() =>
    createOptimisticStore<T>({
      initial,
      context,
      logWarn: (event, line) => {
        logWarn(event, { ...line });
      },
      toast,
    }),
  );
  return [useSyncExternalStore(store.subscribe, store.get, store.get), store];
}
