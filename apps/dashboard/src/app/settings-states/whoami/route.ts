import { apiKeyErrorResponse, createApiKeyVerifier } from '@drefyn/auth';
import { createDatabase, parseDatabaseConfig } from '@drefyn/db';
import type { NextRequest } from 'next/server';
import { visitorBrowser } from '../../../server/actions.ts';
import { guardPublic } from '../../../server/guard.ts';
import { logWarn } from '../../../server/log.ts';
import { appUrl, requestPath } from '../../../server/origin.ts';

let verifier: ReturnType<typeof createApiKeyVerifier> | undefined;

async function apiVerifier() {
  // Only its own key: the verifier refuses to start beside any auth setting.
  const { DREFYN_API_RATE_LIMIT_KEY } = process.env;
  verifier ??= createApiKeyVerifier(
    { DREFYN_API_RATE_LIMIT_KEY },
    {
      db: await createDatabase(parseDatabaseConfig(process.env)),
      logger: {
        info: () => undefined,
        warn: (event) => {
          logWarn(event);
        },
      },
    },
  );
  return verifier;
}

// A stand in for the API service until it exists: the e2e suite proves a key from the page
// works over HTTP here. Only on a server that opted in to the test states.
export async function GET(request: NextRequest): Promise<Response> {
  await guardPublic();
  if (process.env['DREFYN_DASHBOARD_STATES'] !== 'on') return new Response(null, { status: 404 });
  const browser = await visitorBrowser();
  if (browser === null) return new Response(null, { status: 503 });
  const verified = await (
    await apiVerifier()
  ).verifyApiRequest({
    authorization: request.headers.get('authorization') ?? undefined,
    url: appUrl(requestPath(request)),
    ip: browser.ip,
  });
  if (!verified.ok) {
    const { body, status, headers } = apiKeyErrorResponse(verified.error);
    return new Response(body, { status, headers });
  }
  return Response.json({ keyId: verified.value.keyId, scopes: verified.value.scopes });
}
