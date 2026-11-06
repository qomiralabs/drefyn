export const DEFAULT_MAX_HELD_BYTES = 268_435_456;

// One organization alone must not be able to fill the host, so it gets a quarter at most.
const ORGANIZATION_SHARE = 4;

export interface HeldClaim {
  fits(bytes: number): boolean;
  take(bytes: number): boolean;
  release(): void;
}

export interface HeldBytes {
  claim(organization: string): HeldClaim;
  bytes(): number;
  organizations(): number;
}

// Bodies being read and jobs waiting or running. A queue's length stopped bounding its bytes the
// day a job could be a tree, and the memory limit on the host counts neither.
export function createHeldBytes(total: number): HeldBytes {
  const share = Math.floor(total / ORGANIZATION_SHARE);
  const byOrganization = new Map<string, number>();
  let all = 0;

  return {
    claim(organization) {
      let mine = 0;
      const heldBy = () => byOrganization.get(organization) ?? 0;
      const fits = (bytes: number) => heldBy() + bytes <= share && all + bytes <= total;
      return {
        fits,
        take(bytes) {
          if (!fits(bytes)) return false;
          mine += bytes;
          all += bytes;
          byOrganization.set(organization, heldBy() + bytes);
          return true;
        },
        release() {
          all -= mine;
          const left = heldBy() - mine;
          mine = 0;
          if (left > 0) byOrganization.set(organization, left);
          else byOrganization.delete(organization);
        },
      };
    },
    bytes: () => all,
    organizations: () => byOrganization.size,
  };
}
