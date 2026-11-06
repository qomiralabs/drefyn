export const paid = (tier: string) => tier !== 'free';
export const big = (tier: string) => ['scale', 'enterprise'].includes(tier);
export const seats = { free: 5, starter: 10 };
export function label(tier: string) {
  switch (tier) {
    case 'growth':
      return 'Growth';
    default:
      return tier;
  }
}
