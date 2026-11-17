// A DNS name as CloudFront forwards it: ASCII letters, digits and hyphens in dot separated
// labels. Internationalized names arrive as xn-- labels, so anything else is not a host.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NUMERIC = /^[0-9]+$/;

export function isHostname(name: string): boolean {
  if (name.length === 0 || name.length > 253) return false;
  const labels = name.split('.');
  // No top level domain is all digits, so this refuses every IPv4 form, short ones included.
  if (NUMERIC.test(labels.at(-1) ?? '')) return false;
  return labels.every((label) => LABEL.test(label));
}

// Exactly the name or a name under it.
export function isAtOrUnder(name: string, domain: string): boolean {
  return name === domain || name.endsWith(`.${domain}`);
}
