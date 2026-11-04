// Absolute URLs come only from the configured origin. Pure, so a deliberately bad response
// can prove the check goes red without a bad route in the build.

// http and https need no slashes for a browser to read a host.
const ABSOLUTE = /^(?:https?:|(?:[a-z][a-z0-9+.-]*:)?[/\\]{2})/i;
const LINK = /\b(?:href|action|formaction)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

// Fixed text in the product, never built from a request. Exact, so another path or a look
// alike host on it still fails.
const OUR_OWN_LINKS: ReadonlySet<string> = new Set(['https://status.drefyn.com']);

function onOrigin(value: string, origin: string): boolean {
  return value === origin || value.startsWith(`${origin}/`);
}

// A slash and a backslash read as a host to browsers, so only a plain path is relative.
function leaves(value: string, origin: string): boolean {
  if (value.startsWith('/') && !/^\/[/\\]/.test(value)) return false;
  if (!ABSOLUTE.test(value)) return false;
  return !onOrigin(value, origin);
}

export function locationProblem(value: string, origin: string): string | null {
  return leaves(value, origin) ? value : null;
}

export function absoluteLinkProblems(html: string, origin: string): readonly string[] {
  return [...html.matchAll(LINK)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? '')
    .filter((value) => leaves(value, origin) && !OUR_OWN_LINKS.has(value));
}
