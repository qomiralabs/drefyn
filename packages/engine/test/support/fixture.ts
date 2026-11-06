import { randomUUID } from 'node:crypto';
import { createDatabase, parseDatabaseConfig, type Database } from '@drefyn/db';
import { type MdxRoot } from '@drefyn/mdx';
import { createParseClient, type ParseClient } from '@drefyn/mdx/client';
import { idOf, organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { inject } from 'vitest';
import {
  createEngine,
  databaseStore,
  type Actor,
  type Engine,
  type EngineDeps,
  type NodeId,
  type VersionId,
} from '../../src/index.ts';
import { parseClientConfig } from './parse-host.ts';
import { superuser, urlFor } from './stack.ts';

export const database = () => inject('engineDatabase');
export const admin = (text: string) => superuser(text, database());

export const openDatabase = (): Promise<Database> =>
  createDatabase(
    parseDatabaseConfig({
      DREFYN_DATABASE_URL: urlFor('app', database()),
      DREFYN_DATABASE_SSL: 'disable',
    }),
  );

export const PARSE_POLICY = {
  version: 1,
  components: ['Callout'],
  rawHtml: 'sanitize',
  remoteImages: 'proxy',
  linkProtocols: ['https', 'http', 'mailto'],
} as const;

export const parseClient = (): ParseClient =>
  createParseClient(parseClientConfig(inject('engineParseUrl')));

export const ACTOR: Actor = {
  kind: 'user',
  userId: idOf('usr', '01890a5d-ac96-774b-bcce-b302099a8099'),
  roles: ['editor'],
};

export interface Seeded {
  readonly tenant: TenantRef;
  readonly typeId: string;
  readonly organization: string;
  readonly project: string;
}

export interface SeedOptions {
  readonly tier?: string;
  readonly product?: string;
  readonly family?: string;
  // Another project of this organization.
  readonly organization?: string;
}

// Every test gets its own organization, so files and cases never see each other's rows.
export async function seed(options: SeedOptions = {}): Promise<Seeded> {
  const organization = options.organization ?? randomUUID();
  const project = randomUUID();
  const typeId = randomUUID();
  const organizationRow =
    options.organization === undefined
      ? `insert into app.organizations (organization_id, name, plan_tier)
           values ('${organization}', 'Org', '${options.tier ?? 'self_hosted'}');`
      : '';
  await admin(`
${organizationRow}
insert into app.projects (id, organization_id, product, slug, name)
  values ('${project}', '${organization}', '${options.product ?? 'docs'}',
          'p${project.slice(0, 8)}', 'Project');
insert into app.content_types (id, organization_id, project_id, family, key)
  values ('${typeId}', '${organization}', '${project}', '${options.family ?? 'docs_page'}', 'page');
`);
  return {
    tenant: { organizationId: organizationId(organization), projectId: projectId(project) },
    typeId,
    organization,
    project,
  };
}

export interface Built {
  readonly engine: Engine;
  readonly parse: ParseClient;
}

export function buildEngine(db: Database, over: Partial<EngineDeps> = {}): Built {
  const parse = parseClient();
  const engine = createEngine({
    store: databaseStore(db),
    parse,
    parsePolicy: PARSE_POLICY,
    flags: { isOn: () => Promise.resolve(true) },
    ...over,
  });
  return { engine, parse };
}

export async function tree(parse: ParseClient, seeded: Seeded, text: string): Promise<MdxRoot> {
  const answer = await parse.parse({
    tenant: seeded.tenant,
    path: 'test',
    source: text,
    dialect: 'mdx',
    policy: { ...PARSE_POLICY, components: new Set(PARSE_POLICY.components), limits: LIMITS },
  });
  if (!answer.ok) throw new Error(`refused: ${answer.error.map((e) => e.code).join(' ')}`);
  return answer.value.ast;
}

const LIMITS = { maxBytes: 1_048_576, maxDepth: 64, maxNodes: 50_000 };

export async function newNode(engine: Engine, seeded: Seeded): Promise<NodeId> {
  const made = await engine.createNode({
    tenant: seeded.tenant,
    family: 'docs_page',
    typeId: seeded.typeId,
  });
  if (!made.ok) throw new Error(`createNode refused: ${made.error.code}`);
  return made.value.nodeId;
}

export const key = () => randomUUID();

export interface Saved {
  readonly versionId: VersionId;
  readonly seq: number;
}

export async function save(
  built: Built,
  seeded: Seeded,
  nodeId: NodeId,
  expected: VersionId | null,
  text: string,
): Promise<Saved> {
  const done = await built.engine.saveDraft({
    tenant: seeded.tenant,
    nodeId,
    expectedHeadVersionId: expected,
    content: await tree(built.parse, seeded, text),
    origin: 'human',
    actor: ACTOR,
    idempotencyKey: key(),
  });
  if (!done.ok) throw new Error(`saveDraft refused: ${done.error.code}`);
  return done.value;
}

export const versionCount = async (node: string): Promise<number> =>
  Number(await admin(`select count(*) from app.node_versions where node_id = '${node}';`));
