import { notFound } from 'next/navigation';
import { FACTOR_STATES } from '../../../../server/factor-gallery.ts';
import { guardPublic } from '../../../../server/guard.ts';

interface Context {
  readonly params: Promise<{ readonly state: string }>;
}

// The pages the enrolment routes answer with, drawn from fixed made up values for the
// visual and axe specs. A server opts in, so an ordinary install answers 404.
export async function GET(_request: Request, { params }: Context): Promise<Response> {
  await guardPublic();
  if (process.env['DREFYN_DASHBOARD_STATES'] !== 'on') notFound();
  const draw = FACTOR_STATES[(await params).state];
  if (draw === undefined) notFound();
  return new Response(draw(), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
