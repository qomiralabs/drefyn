import type { Violation } from './csp.ts';

export const WEBKIT_REFUSED_STYLE = /^Refused to apply a stylesheet because/;

const isBareEvent = (v: Violation) =>
  v.directive === 'style-src-attr' && v.blocked === 'inline' && v.sample === '';
const isRefusedLine = (v: Violation) =>
  v.directive === 'console' && WEBKIT_REFUSED_STYLE.exec(v.sample) !== null;

// Playwright's WebKit reports a style violation for every select it creates, with nothing set
// by the page. Safari does not. Only that many are removed, so any other violation still fails.
export function withoutWebKitSelectArtefact(
  browserName: string,
  violations: readonly Violation[],
  selectsCreated: number,
): readonly Violation[] {
  if (browserName !== 'webkit') return violations;
  let events = selectsCreated;
  let lines = selectsCreated;
  return violations.filter((violation) => {
    if (events > 0 && isBareEvent(violation)) {
      events -= 1;
      return false;
    }
    if (lines > 0 && isRefusedLine(violation)) {
      lines -= 1;
      return false;
    }
    return true;
  });
}
