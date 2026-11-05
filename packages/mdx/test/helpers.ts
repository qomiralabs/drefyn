import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { organizationId, projectId } from '@drefyn/tenancy';
import { z } from 'zod';
import { DEFAULT_LIMITS } from '../src/index.ts';
import { parseForStore } from '../src/parse.ts';
import type { Dialect, MdxIssue, MdxRoot, RenderPolicy } from '../src/index.ts';

export const policy = (overrides: Partial<RenderPolicy> = {}): RenderPolicy => ({
  version: 1,
  components: new Set<string>(),
  rawHtml: 'sanitize',
  remoteImages: 'proxy',
  linkProtocols: ['https', 'http', 'mailto'],
  limits: DEFAULT_LIMITS,
  ...overrides,
});

export const limits = (overrides: Partial<RenderPolicy['limits']>): RenderPolicy =>
  policy({ limits: { ...DEFAULT_LIMITS, ...overrides } });

export function parsed(source: string, dialect: Dialect = 'mdx', use = policy()): MdxRoot {
  const result = parseForStore(source, dialect, use);
  if (!result.ok) throw new Error(`refused: ${codes(result.error).join(' ')}`);
  return result.value.ast;
}

export function issuesOf(source: string, dialect: Dialect, use = policy()): readonly MdxIssue[] {
  const result = parseForStore(source, dialect, use);
  return result.ok ? result.value.issues : result.error;
}

export const codes = (issues: readonly MdxIssue[]) => issues.map((issue) => issue.code);

const entrySchema = z.array(
  z.strictObject({
    file: z.string().regex(/^[a-z]+-[0-9a-f]{10}\.mdx?\.txt$/),
    repo: z.string(),
    commit: z.string().regex(/^[0-9a-f]{7}$/),
    path: z.string(),
    license: z.enum(['MIT', 'Apache-2.0']),
    dialect: z.enum(['mdx', 'md']),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
);

export interface CorpusFile {
  readonly file: string;
  readonly repo: string;
  readonly path: string;
  readonly dialect: Dialect;
  readonly sha256: string;
  readonly bytes: Buffer;
  readonly text: string;
}

const fixtures = new URL('./fixtures/', import.meta.url);

export function loadCorpus(): readonly CorpusFile[] {
  const manifest = entrySchema.parse(
    JSON.parse(readFileSync(new URL('manifest.json', fixtures), 'utf8')),
  );
  return manifest.map(({ file, repo, path, dialect, sha256 }) => {
    const bytes = readFileSync(new URL(`corpus/${file}`, fixtures));
    return { file, repo, path, dialect, sha256, bytes, text: bytes.toString('utf8') };
  });
}

export const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

// Real files have few CRLF or BOM cases, so those are derived from the same real text.
const BOM = String.fromCharCode(0xfeff);

export const VARIANTS: readonly (readonly [string, (text: string) => string])[] = [
  ['crlf', (text) => text.replace(/\r?\n/g, '\r\n')],
  ['bom', (text) => `${BOM}${text}`],
  ['bom and crlf', (text) => `${BOM}${text.replace(/\r?\n/g, '\r\n')}`],
  [
    'mixed',
    (text) => {
      let line = 0;
      return text.replace(/\r?\n/g, () => (line++ % 3 === 0 ? '\r\n' : '\n'));
    },
  ],
  ['no final newline', (text) => text.trimEnd()],
  ['trailing bytes', (text) => `${text}\n\n  \t\n`],
];

export const ORG_A = organizationId('00000000-0000-4000-8000-00000000000a');
export const PROJECT_A = projectId('00000000-0000-4000-8000-0000000000a1');
export const PROJECT_B = projectId('00000000-0000-4000-8000-0000000000b1');

// A project id per index, for tests that want many tenants.
export const projectAt = (index: number) =>
  projectId(`00000000-0000-4000-9000-${index.toString(16).padStart(12, '0')}`);

export const isolatedPolicy = (components: readonly string[] = []) => ({
  ...policy(),
  components: new Set(components),
});

export const POOL_CONFIG = {
  timeoutMs: 1_000,
  maxMemoryMb: 256,
  threads: 2,
  maxQueued: 8,
  projectThreads: 1,
  maxQueuedPerProject: 4,
  projectBudgetMs: 60_000,
  projectWindowMs: 120_000,
};

export interface LogEntry {
  readonly level: 'info' | 'warn';
  readonly event: string;
  readonly fields: Readonly<Record<string, string | number | boolean>>;
}

export function recordingLogger() {
  const entries: LogEntry[] = [];
  return {
    entries,
    info(event: string, fields: LogEntry['fields']) {
      entries.push({ level: 'info', event, fields });
    },
    warn(event: string, fields: LogEntry['fields']) {
      entries.push({ level: 'warn', event, fields });
    },
  };
}
