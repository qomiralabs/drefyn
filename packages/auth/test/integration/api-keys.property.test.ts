import { idOf, type ProjectId } from '@drefyn/tenancy';
import fc from 'fast-check';
import { beforeAll, expect, it } from 'vitest';
import { formatApiKey, parseApiKey, type ApiKeyVerifier } from '../../src/index.ts';
import {
  addProjects,
  deleteProject,
  input,
  memberOf,
  newOrg,
  type Org,
} from './support/api-keys.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';

const fresh = harness();
let h: Harness;

interface Seeded {
  readonly org: Org;
  readonly projects: readonly ProjectId[];
  readonly keys: readonly {
    readonly secret: string;
    readonly listed: readonly ProjectId[] | 'all';
  }[];
}

const IP = '203.0.113.50';
let world: Seeded[] = [];
let verifier: ApiKeyVerifier;

// Never rate limited here: the limiter has its own test, and these runs fail on purpose.
const unlimited = { reserve: () => Promise.resolve() };

describeWithStack('API keys across organizations', () => {
  beforeAll(async () => {
    h = await fresh();
    verifier = h.verifier({ limiter: unlimited });
    world = [];
    for (let i = 0; i < 3; i += 1) {
      const org = await newOrg(h);
      const projects = await addProjects(h, org.organizationId, 3);
      const keys = h.apiKeys();
      const made: Seeded['keys'][number][] = [];
      for (const listed of [[projects[0]], [projects[1], projects[2]], 'all'] as const) {
        const ids = listed === 'all' ? [] : listed.filter((p) => p !== undefined);
        const result = await keys.createApiKey(
          org.owner,
          input(listed === 'all' ? {} : { projectScope: 'listed', projectIds: ids }),
        );
        if (!result.ok) throw result.error;
        made.push({ secret: result.value.secret, listed: listed === 'all' ? 'all' : ids });
      }
      world.push({ org, projects, keys: made });
    }
  });

  it('a key only ever proves itself under its own organization and reaches only its projects', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: 2 }),
        fc.nat({ max: 2 }),
        fc.nat({ max: 2 }),
        async (owner, keyIndex, claimed) => {
          const from = world[owner];
          const to = world[claimed];
          const key = from?.keys[keyIndex];
          if (from === undefined || to === undefined || key === undefined) throw new Error('world');
          const parts = parseApiKey(key.secret);
          if (parts === null) throw new Error('not a key');
          // The same key id and secret, presented under the claimed organization.
          const presented = formatApiKey({ ...parts, organizationId: to.org.organizationId });
          const result = await verifier.verifyApiKey(`Bearer ${presented}`, IP);
          if (owner !== claimed) {
            expect(result.ok).toBe(false);
            return;
          }
          if (!result.ok) throw result.error;
          expect(result.value.organizationId).toBe(from.org.organizationId);
          expect(result.value.projectIds).toEqual(
            key.listed === 'all' ? 'all' : [...key.listed].sort(),
          );
          if (result.value.projectIds !== 'all') {
            for (const p of result.value.projectIds) expect(from.projects).toContain(p);
          }
        },
      ),
      { seed: 132, numRuns: 30 },
    );
  });

  it('a guessed key id never proves anything in any organization', async () => {
    await fc.assert(
      fc.asyncProperty(fc.nat({ max: 2 }), fc.uuid({ version: 7 }), async (claimed, guess) => {
        const to = world[claimed];
        const parts = parseApiKey(to?.keys[0]?.secret);
        if (to === undefined || parts === null) throw new Error('world');
        const presented = formatApiKey({ ...parts, keyId: idOf('key', guess) });
        expect((await verifier.verifyApiKey(`Bearer ${presented}`, IP)).ok).toBe(false);
      }),
      { seed: 133, numRuns: 20 },
    );
  });
});

type Step = { readonly kind: 'create' } | { readonly kind: 'delete'; readonly pick: number };

const steps: fc.Arbitrary<Step[]> = fc.array(
  fc.oneof(
    fc.constant<Step>({ kind: 'create' }),
    fc.nat({ max: 50 }).map<Step>((pick) => ({ kind: 'delete', pick })),
  ),
  { minLength: 1, maxLength: 8 },
);

describeWithStack('a listed key never widens', () => {
  beforeAll(async () => {
    h = await fresh();
    verifier = h.verifier({ limiter: unlimited });
  });

  it('for any sequence of project creations and deletions, its reach never grows', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 3 }), steps, async (listedCount, plan) => {
        const org = await newOrg(h);
        const live = await addProjects(h, org.organizationId, listedCount + 1);
        const listed = live.slice(0, listedCount);
        const made = await h
          .apiKeys()
          .createApiKey(org.owner, input({ projectScope: 'listed', projectIds: listed }));
        if (!made.ok) throw made.error;
        const reach = async () => {
          const result = await verifier.verifyApiKey(`Bearer ${made.value.secret}`, IP);
          if (!result.ok) throw result.error;
          if (result.value.projectIds === 'all') throw new Error('a listed key read as all');
          return result.value.projectIds;
        };
        let before = await reach();
        expect(before).toEqual([...listed].sort());
        for (const step of plan) {
          if (step.kind === 'create') {
            live.push(...(await addProjects(h, org.organizationId, 1)));
          } else if (live.length > 0) {
            const [gone] = live.splice(step.pick % live.length, 1);
            if (gone !== undefined) await deleteProject(h, org.organizationId, gone);
          }
          const after = await reach();
          for (const p of after) expect(before).toContain(p);
          before = after;
        }
      }),
      { seed: 134, numRuns: 15 },
    );
  });

  it('a revoked key never verifies, in any order with demotion, promotion and removal', async () => {
    type Step = 'revoke' | 'demote' | 'promote' | 'remove' | 'verify';
    const step = fc.constantFrom<Step>('revoke', 'demote', 'promote', 'remove', 'verify');
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 6 }), async (steps) => {
        const org = await newOrg(h);
        const { access: admin } = await memberOf(h, org, 'admin');
        const made = await h.apiKeys().createApiKey(admin, input());
        if (!made.ok) throw made.error;
        const { keyId } = made.value.key;
        const membership = idOf(
          'mem',
          await h.sql(
            `select id from app.memberships
              where organization_id = '${org.organizationId}' and user_id = '${admin.userId}';`,
          ),
        );
        const proves = async () =>
          (await verifier.verifyApiKey(`Bearer ${made.value.secret}`, IP)).ok;
        // The oracle: only revoke, a demotion to member or a removal ends the key, and nothing
        // brings it back. Once removed, the role steps have nobody left to act on.
        let ended = false;
        let inOrg = true;
        for (const next of steps) {
          if (next === 'revoke') {
            const done = await h.apiKeys().revokeApiKey(org.owner, keyId);
            if (!done.ok) throw done.error;
            ended = true;
          } else if (next === 'demote' && inOrg) {
            const done = await h.roles().changeRole(org.owner, membership, 'member');
            if (!done.ok) throw done.error;
            ended = true;
          } else if (next === 'promote' && inOrg) {
            const done = await h.roles().changeRole(org.owner, membership, 'admin');
            if (!done.ok) throw done.error;
          } else if (next === 'remove' && inOrg) {
            const done = await h.roles().removeMember(org.owner, membership);
            if (!done.ok) throw done.error;
            ended = true;
            inOrg = false;
          }
          expect(await proves()).toBe(!ended);
        }
      }),
      { numRuns: 20 },
    );
  }, 120_000);

  it('a listed key whose projects are all gone reaches none, never all', async () => {
    const org = await newOrg(h);
    const listed = await addProjects(h, org.organizationId, 2);
    const made = await h
      .apiKeys()
      .createApiKey(org.owner, input({ projectScope: 'listed', projectIds: listed }));
    if (!made.ok) throw made.error;
    for (const p of listed) await deleteProject(h, org.organizationId, p);
    expect(
      await h.sql(`select project_scope from app.api_keys where id = '${made.value.key.keyId}';`),
    ).toBe('listed');
    const result = await verifier.verifyApiKey(`Bearer ${made.value.secret}`, IP);
    if (!result.ok) throw result.error;
    expect(result.value.projectIds).toEqual([]);
    // A project created afterwards is not reached either.
    await addProjects(h, org.organizationId, 1);
    const later = await verifier.verifyApiKey(`Bearer ${made.value.secret}`, IP);
    if (!later.ok) throw later.error;
    expect(later.value.projectIds).toEqual([]);
  });
});
