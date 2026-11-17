import { surfaceTokensCss } from '@drefyn/ui';
import { FACTOR_CSS } from '../../../server/factor-page.ts';
import { guardPublic } from '../../../server/guard.ts';

const BODY = `${surfaceTokensCss.status}${FACTOR_CSS}`;

// The stylesheet of the pages that show a secret, which carry no inline style. It holds
// tokens and layout only, the same for everyone, so it may be cached.
export async function GET(): Promise<Response> {
  await guardPublic();
  return new Response(BODY, {
    headers: {
      'content-type': 'text/css; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}
