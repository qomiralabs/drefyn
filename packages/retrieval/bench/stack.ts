import {
  closeDatabase,
  createDatabase,
  createPublishedDatabase,
  parseDatabaseConfig,
  parsePublishedReaderConfig,
  type Database,
  type PublishedDatabase,
} from '@drefyn/db';
import {
  appTermStore,
  createRetrieval,
  createTermRebuild,
  DEFAULT_RETRIEVAL_CONFIG,
  publishedReader,
  type Retrieval,
} from '../src/index.ts';
import { migratedDatabase } from '../test/support/global-setup.ts';
import { stackAbsence, superuser, urlFor } from '../test/support/stack.ts';
import type { Project } from './load.ts';

// What the bench and the eval share: a migrated database of their own on the compose stack,
// the two roles, and the library over the public reader with the flag on.
export interface Harness {
  readonly name: string;
  readonly app: Database;
  readonly reader: PublishedDatabase;
  readonly retrieval: Retrieval;
  rebuild(project: Project): Promise<void>;
  close(): Promise<void>;
}

export async function openHarness(prefix: string): Promise<Harness> {
  const absent = await stackAbsence();
  if (absent !== null) throw new Error(`needs the compose stack: ${absent}`);
  const { name, drop } = await migratedDatabase(prefix);
  const app = await createDatabase(
    parseDatabaseConfig({
      DREFYN_DATABASE_URL: urlFor('app', name),
      DREFYN_DATABASE_SSL: 'disable',
    }),
  );
  // One connection: every timing is one client asking one question at a time.
  const reader = await createPublishedDatabase(
    parsePublishedReaderConfig({
      DREFYN_PUBLIC_READER_DATABASE_URL: urlFor('reader', name),
      DREFYN_DATABASE_SSL: 'disable',
      DREFYN_DATABASE_POOL_MAX: '1',
    }),
  );
  const retrieval = createRetrieval({
    reader: publishedReader(reader),
    config: DEFAULT_RETRIEVAL_CONFIG,
    flags: { evaluate: () => Promise.resolve({ value: true }) },
  });
  const rebuilder = createTermRebuild({ store: appTermStore(app, { timeoutMs: 60_000 }) });
  return {
    name,
    app,
    reader,
    retrieval,
    async rebuild(project) {
      const rebuilt = await rebuilder.rebuildTermStats(project.tenant);
      if (!rebuilt.ok)
        throw new Error(`term rebuild failed for project ${project.tenant.projectId}`);
    },
    async close() {
      await closeDatabase(reader);
      await closeDatabase(app);
      await drop();
    },
  };
}

// Index only scans need the visibility map, and the planner needs statistics.
export const vacuum = (name: string) => superuser('vacuum (analyze);', name);

export const percentile = (values: readonly number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? Number.NaN;
};

export const ms = (value: number) => value.toFixed(1);

// pnpm passes a lone -- through to the script.
export const scriptArgs = () => process.argv.slice(2).filter((arg) => arg !== '--');
