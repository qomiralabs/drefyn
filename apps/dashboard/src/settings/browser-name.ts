import { userAgentFamily } from '@drefyn/auth';

// Only the family from our closed list reaches the page, never the stored string.
export function browserName(userAgent: string | null, method: string): string {
  if (method === 'cli_link') return 'Command line';
  const family = userAgent === null ? 'Other' : userAgentFamily(userAgent);
  return family === 'Other' ? 'Unknown browser' : family;
}
