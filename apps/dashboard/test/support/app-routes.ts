import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// Groups and parallel slots add nothing to the URL, so what they hold sits at the top level.
const PASS_THROUGH = /^[(@]/;
const NOT_A_ROUTE = /^[[_]/;

export function appRoutes(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !NOT_A_ROUTE.test(entry.name))
    .flatMap((entry) =>
      PASS_THROUGH.test(entry.name) ? appRoutes(join(directory, entry.name)) : [entry.name],
    );
}
