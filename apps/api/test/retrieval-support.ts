import type { Retrieval, RetrieveInput, RetrieveResult } from '@drefyn/retrieval';
import type { TenantRef } from '@drefyn/tenancy';
import { vi } from 'vitest';
import { createApp, type ApiDeps } from '../src/app.ts';
import { mountRetrieval } from '../src/retrieve.ts';
import { actor, fakeDeps, fakeKeys, GOOD, OTHER_PROJECT } from './support.ts';

export const DOCS_KEY = 'Bearer docs';
export const PUBLISH_ONLY = 'Bearer publish-only';
export const STUDIO_KEY = 'Bearer studio';
export const DOCS_LISTED = 'Bearer docs-listed';

export const RESULT: RetrieveResult = Object.freeze({
  pin: { version: 'latest', publishedAt: '2026-11-17T10:00:00.000Z' },
  ranking: 'lexical',
  hits: [
    {
      chunkId: '01a14984-4476-77ce-9335-2c3c3a59ab01',
      nodeId: '01a14984-4476-77ce-9335-2c3c3a59ab02',
      versionId: '01a14984-4476-77ce-9335-2c3c3a59ab03',
      path: '/guides/install',
      title: 'Install',
      headingPath: ['Install', 'With Docker'],
      text: 'Run the installer, then open the dashboard.',
      rank: 1,
    },
  ],
} as RetrieveResult);

export interface Recorded {
  readonly tenant: TenantRef;
  readonly input: RetrieveInput;
}

// A retrieval that answers what the test says and records what the route asked.
export function fakeRetrieval(
  answer: Awaited<ReturnType<Retrieval['retrieve']>> = { ok: true, value: RESULT },
) {
  const calls: Recorded[] = [];
  const retrieve = vi.fn<Retrieval['retrieve']>((tenant, input) => {
    calls.push({ tenant, input });
    return Promise.resolve(answer);
  });
  return { retrieval: { retrieve }, calls, retrieve };
}

// DOCS_KEY reads every docs project of ORG; the others each lack something the route needs.
export function retrievalKeys() {
  return fakeKeys({
    [DOCS_KEY]: actor({ scopes: ['docs:pages.read'] }),
    [PUBLISH_ONLY]: actor({ scopes: ['docs:pages.publish'] }),
    [STUDIO_KEY]: actor({ scopes: ['studio:content.read'] }),
    [DOCS_LISTED]: actor({ scopes: ['docs:pages.read'], projectIds: [OTHER_PROJECT] }),
    [GOOD]: actor(),
  });
}

export function retrievalApp(
  over: Partial<ApiDeps> = {},
  retrieval: ReturnType<typeof fakeRetrieval> = fakeRetrieval(),
) {
  const base = fakeDeps({ keys: retrievalKeys().keys, ...over });
  const app = createApp(base.deps);
  mountRetrieval(app, base.deps, retrieval.retrieval);
  return { ...base, app, ...retrieval };
}
