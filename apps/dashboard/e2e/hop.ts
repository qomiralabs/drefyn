import type { BrowserContext } from '@playwright/test';
import { HOP_HOST, HOP_PORT, HOP_SERVER_PORT } from './fixtures.ts';

// The one trusted hop, in Playwright's route layer: the browser keeps the https origin, and
// each request reaches the wrapper on loopback with the Host a real proxy would keep and the
// X-Forwarded-For it would write. The wrapper runs with hops 1 and a non loopback origin, as
// in production, and nothing on the server knows this is a test.
export async function behindHop(context: BrowserContext, client: string): Promise<void> {
  await context.route(`https://${HOP_HOST}:${String(HOP_PORT)}/**`, async (route) => {
    const request = route.request();
    const { pathname, search } = new URL(request.url());
    const response = await route.fetch({
      url: `http://127.0.0.1:${String(HOP_SERVER_PORT)}${pathname}${search}`,
      headers: {
        ...(await request.allHeaders()),
        host: `${HOP_HOST}:${String(HOP_PORT)}`,
        'x-forwarded-for': client,
      },
      maxRedirects: 0,
    });
    await route.fulfill({ response });
  });
}
