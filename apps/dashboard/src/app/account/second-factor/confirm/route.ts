import { signedInRoute } from '../../../../server/actions.ts';
import { confirmEnrolment } from '../../../../server/factor-routes.ts';

export const POST = signedInRoute(confirmEnrolment);
