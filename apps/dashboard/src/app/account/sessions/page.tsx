import type { Metadata } from 'next';
import { dashboardAuth } from '../../../server/auth.ts';
import { guardAccountHome } from '../../../server/guard.ts';
import { failureReference } from '../../../server/sign-in-support.ts';
import { browserName } from '../../../settings/browser-name.ts';
import { LoadProblem } from '../../../settings/parts.tsx';
import { SessionsScreen, type SessionRow } from '../../../settings/sessions.tsx';

export async function generateMetadata(): Promise<Metadata> {
  await guardAccountHome();
  return { title: 'Sessions' };
}

async function readSessions(session: Awaited<ReturnType<typeof guardAccountHome>>['session']) {
  const auth = await dashboardAuth();
  try {
    return await auth.sessions.listSessions(session);
  } catch {
    return null;
  }
}

export default async function SessionsPage() {
  const { session } = await guardAccountHome();
  const sessions = await readSessions(session);
  if (sessions === null) {
    return (
      <LoadProblem
        title="Could not load your sessions"
        reference={failureReference('settings.sessions_read_failed')}
      >
        Nobody was signed out. Try again; if you think someone else is signed in, reset your
        password from the sign in page, which signs out everyone else.
      </LoadProblem>
    );
  }
  const rows: SessionRow[] = sessions.map((row) => ({
    id: row.sessionId,
    browser: browserName(row.userAgent, row.method),
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    current: row.current,
  }));
  return <SessionsScreen sessions={rows} now={new Date().toISOString()} />;
}
