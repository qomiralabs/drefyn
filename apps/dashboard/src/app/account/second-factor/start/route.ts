import { signedInRoute } from '../../../../server/actions.ts';
import { startEnrolment } from '../../../../server/factor-routes.ts';

export const POST = signedInRoute(startEnrolment);
