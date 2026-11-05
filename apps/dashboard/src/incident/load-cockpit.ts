import type { ComponentType } from 'react';
import type { CockpitProps } from './cockpit.tsx';

let loading: Promise<ComponentType<CockpitProps>> | null = null;

// In a chunk of its own, with Motion, so no route pays for incident mode until one opens. A
// failed load is forgotten, so the next try asks the network again.
export function loadCockpit(): Promise<ComponentType<CockpitProps>> {
  loading ??= import('./cockpit.tsx')
    .then((mod) => mod.Cockpit)
    .catch((error: unknown) => {
      loading = null;
      throw error;
    });
  return loading;
}
