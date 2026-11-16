import { signedInRoute } from '../../../../server/actions.ts';
import { replaceCodes } from '../../../../server/factor-routes.ts';

export const POST = signedInRoute(replaceCodes);
