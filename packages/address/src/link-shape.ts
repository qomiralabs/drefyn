import { isNormalizedEmailAddress } from './normalize.ts';

const SCHEME = '://';
const WWW = 'www.';
// Removed for the check only: mail clients drop what a reader cannot see, so a joiner inside
// a domain still gives the domain.
const FORMAT = /\p{Cf}/gu;
// Separators IDNA and browsers treat as a dot, after NFKC has folded the full width forms.
const DOTS = /[。．｡]/g;
// Combining marks go too, so a mark inside the top level label (or the one the dotted capital
// I leaves after lowercasing) cannot split it.
const MARKS = /\p{M}/gu;
// Anything but a space or another dot before it: linkifiers take underscores, hyphens and
// marks in a label, and checking for letters only let those through.
const DOMAIN_LIKE = /[^\s.]\.\p{L}{2,}/u;
// An allow list, since the local part rule is wide and linkifiers vary.
const PLAIN_LOCAL = /^[a-z0-9._+'-]+$/;

// Text a mail client could turn into a link: a scheme, www. anywhere, or a domain shape.
export function isLinkShaped(text: string): boolean {
  const folded = text
    .normalize('NFKC')
    .replace(FORMAT, '')
    .replace(DOTS, '.')
    .toLowerCase()
    .replace(MARKS, '');
  return folded.includes(SCHEME) || folded.includes(WWW) || DOMAIN_LIKE.test(folded);
}

// A normalised address whose local part cannot read as a link. The address rule allows
// / ? # % = & there, and a catch all domain makes any local part deliverable.
export function isPlainAddress(value: string): boolean {
  if (!isNormalizedEmailAddress(value)) return false;
  const local = value.slice(0, value.indexOf('@'));
  return PLAIN_LOCAL.test(local) && !local.includes(WWW);
}
