import type { TeamSsoFlag, TotpFlag } from '@drefyn/auth';
import { createFlagClient, loadFlagConfig, type FlagClient } from '@drefyn/flags';
import { mailDelivery, teamSso, VISITOR_FLAG_ORGANIZATION } from '../shell/release.ts';
import { logWarn } from './log.ts';

let client: Promise<FlagClient> | undefined;

// One client per module copy. A client that failed to start is dropped, so the next ask
// tries again instead of keeping a feature off until a restart. Kept free of Next, so the
// production server can read flags before and beside it.
export function flagClient(): Promise<FlagClient> {
  client ??= createFlagClient(loadFlagConfig(process.env), {
    // The dashboard reads release flags only; plan flags go through entitlements.
    entitlements: { hasFeature: () => Promise.resolve(false) },
    logger: {
      warn: (event, fields) => {
        logWarn(event, fields);
      },
    },
  }).catch((error: unknown) => {
    client = undefined;
    throw error;
  });
  return client;
}

// Asked once per process, about nobody in particular: mail is a server setting. Any failure
// is off, the safe value, and a change applies on restart.
export async function mailDeliveryEnabled(): Promise<boolean> {
  try {
    return await mailDelivery(await flagClient(), { organizationId: VISITOR_FLAG_ORGANIZATION });
  } catch {
    logWarn('dashboard.flag_client_failed', {});
    return false;
  }
}

// The server wide answer, for work no organization asked for. Each organization is still
// asked on its own before anything of its is touched.
export async function teamSsoForServer(): Promise<boolean> {
  try {
    return await teamSso(await flagClient(), { organizationId: VISITOR_FLAG_ORGANIZATION });
  } catch {
    logWarn('dashboard.flag_client_failed', {});
    return false;
  }
}

// Auth treats a throw as off, so a client that failed to start needs no catch here.
export const teamSsoFlag: TeamSsoFlag = Object.freeze({
  isOn: async (name: 'auth.team_sso', ctx: Parameters<TeamSsoFlag['isOn']>[1]) =>
    (await flagClient()).isOn(name, ctx),
});

// Enrolment is about a person, who may belong to no organization, so the person is the
// only context that tells one answer from another. Auth treats a throw as off.
export const totpFlag: TotpFlag = Object.freeze({
  isOn: async (name: 'auth.totp', ctx: Parameters<TotpFlag['isOn']>[1]) =>
    (await flagClient()).isOn(name, {
      organizationId: VISITOR_FLAG_ORGANIZATION,
      userId: ctx.userId,
    }),
});
