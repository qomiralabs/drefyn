import type { Metadata } from 'next';
import { dashboardAuth } from '../../../server/auth.ts';
import { guardAccountHome } from '../../../server/guard.ts';
import { identityRows } from '../../../server/settings-views.ts';
import { failureReference } from '../../../server/sign-in-support.ts';
import { browserName } from '../../../settings/browser-name.ts';
import { MethodsScreen } from '../../../settings/methods.tsx';
import { LoadProblem } from '../../../settings/parts.tsx';

interface Props {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

export async function generateMetadata(): Promise<Metadata> {
  await guardAccountHome();
  return { title: 'Sign in methods' };
}

export default async function MethodsPage({ searchParams }: Props) {
  const { session } = await guardAccountHome();
  const auth = await dashboardAuth();
  const read = await auth.account.readAccount(session);
  if (!read.ok) {
    return (
      <LoadProblem
        title="Could not load your sign in methods"
        reference={failureReference('settings.methods_read_failed')}
      >
        Nothing changed, and every way you sign in still works. Only this page did not load.
      </LoadProblem>
    );
  }
  const sessions = await auth.sessions.listSessions(session).catch(() => []);
  const { value } = read;
  const { error } = await searchParams;
  return (
    <MethodsScreen
      providerFailed={error === 'provider'}
      facts={{
        email: value.email,
        emailOn: auth.methods.email,
        passwordsOn: auth.methods.password,
        configured: auth.methods.providers,
        passwordSetAt: value.passwordSetAt?.toISOString() ?? null,
        identities: identityRows(value),
        others: sessions
          .filter((row) => !row.current)
          .map((row) => ({ id: row.sessionId, browser: browserName(row.userAgent, row.method) })),
      }}
    />
  );
}
