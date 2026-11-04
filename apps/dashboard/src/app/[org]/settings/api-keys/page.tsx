import { API_KEY_SCOPES } from '@drefyn/auth/permissions';
import type { IdOf } from '@drefyn/tenancy';
import type { Metadata } from 'next';
import { dashboardAuth } from '../../../../server/auth.ts';
import { guardOrganization } from '../../../../server/guard.ts';
import { appOrigin } from '../../../../server/origin.ts';
import { keyRows } from '../../../../server/settings-views.ts';
import { failureReference, hosted } from '../../../../server/sign-in-support.ts';
import { KeysScreen } from '../../../../settings/api-keys.tsx';
import { firstPage, keyFiltersFrom, keyListInput } from '../../../../settings/models.ts';
import { LoadProblem } from '../../../../settings/parts.tsx';

interface Params {
  params: Promise<{ org: string }>;
  searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

const HOSTED_API = 'https://api.drefyn.com';

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  await guardOrganization((await params).org);
  return { title: 'API keys' };
}

export default async function ApiKeysPage({ params, searchParams }: Params) {
  const { org } = await params;
  const { access, view } = await guardOrganization(org);
  const filters = keyFiltersFrom(await searchParams);
  const auth = await dashboardAuth();
  const manage = access.permissions.includes('org.manage_api_keys');
  const asInput = (from: typeof filters) => {
    const { createdBy, ...input } = keyListInput(from);
    return {
      ...input,
      ...(createdBy === undefined
        ? {}
        : { createdBy: createdBy as readonly (IdOf<'mem'> | 'former')[] }),
    };
  };
  const first = await auth.apiKeys.listApiKeys(access, asInput(filters));
  // A cursor is opaque and a URL can hold anything, so a bad one is the first page.
  const page =
    !first.ok && first.error.code === 'AUTH_INPUT_INVALID'
      ? await auth.apiKeys.listApiKeys(access, asInput(firstPage(filters)))
      : first;
  const projects = manage ? await auth.members.listProjects(access) : null;
  if (!page.ok || projects?.ok === false) {
    return (
      <LoadProblem
        title="Could not load API keys"
        reference={failureReference('settings.keys_read_failed')}
      >
        Every key still works as before. Only this page did not load.
      </LoadProblem>
    );
  }
  const named = projects?.ok === true ? projects.value : [];
  const { value } = page;
  return (
    <KeysScreen
      facts={{
        org,
        organization: view.organizationName,
        manage,
        apiOrigin: hosted() ? HOSTED_API : appOrigin(),
        now: new Date().toISOString(),
        keys: keyRows(value),
        matched: value.matched,
        total: value.total,
        live: value.live,
        nextCursor: value.nextCursor,
        creators: value.creators,
        formerKeys: value.formerKeys,
        products: value.products,
        filters,
        projectNames: Object.fromEntries(named.map((p) => [p.projectId, p.name])),
        projects: named.map((p) => ({ id: p.projectId, name: p.name })),
        grantable: API_KEY_SCOPES.filter((s) => access.permissions.includes(s.permission)).map(
          (s) => s.scope,
        ),
      }}
    />
  );
}
