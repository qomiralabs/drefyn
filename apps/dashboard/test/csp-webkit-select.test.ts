import { describe, expect, it } from 'vitest';
import type { Violation } from '../e2e/csp.ts';
import { WEBKIT_REFUSED_STYLE, withoutWebKitSelectArtefact } from '../e2e/csp-webkit-select.ts';

const REFUSED =
  "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.";
const EVENT: Violation = { directive: 'style-src-attr', blocked: 'inline', sample: '' };
const LINE: Violation = { directive: 'console', blocked: 'error', sample: REFUSED };
const OTHER: Violation = { directive: 'script-src-elem', blocked: 'inline', sample: '' };

describe('withoutWebKitSelectArtefact', () => {
  it('knows the words WebKit uses', () => {
    expect(WEBKIT_REFUSED_STYLE.test(REFUSED)).toBe(true);
    expect(WEBKIT_REFUSED_STYLE.test('Refused to execute a script')).toBe(false);
  });

  it.each(['chromium', 'firefox', ''])('leaves %j alone whatever was counted', (engine) => {
    const list = [EVENT, LINE];
    expect(withoutWebKitSelectArtefact(engine, list, 5)).toEqual(list);
  });

  it('removes one pair per select', () => {
    expect(withoutWebKitSelectArtefact('webkit', [EVENT, LINE, EVENT, LINE], 2)).toEqual([]);
  });

  it('leaves one extra event', () => {
    expect(withoutWebKitSelectArtefact('webkit', [EVENT, LINE, EVENT], 1)).toEqual([EVENT]);
  });

  it('leaves one extra console line', () => {
    expect(withoutWebKitSelectArtefact('webkit', [LINE, EVENT, LINE], 1)).toEqual([LINE]);
  });

  it('removes nothing with no select counted', () => {
    expect(withoutWebKitSelectArtefact('webkit', [EVENT, LINE], 0)).toEqual([EVENT, LINE]);
  });

  it('leaves a different directive at an equal count', () => {
    expect(withoutWebKitSelectArtefact('webkit', [OTHER, LINE], 1)).toEqual([OTHER]);
  });

  it('leaves an event that carries a sample or blocks something else', () => {
    const sampled = { ...EVENT, sample: 'color: red' };
    const blocked = { ...EVENT, blocked: 'https://evil.example/x.css' };
    expect(withoutWebKitSelectArtefact('webkit', [sampled, blocked], 2)).toEqual([
      sampled,
      blocked,
    ]);
  });

  it('leaves a console line in other words', () => {
    const line = { ...LINE, sample: 'Refused to load the font' };
    expect(withoutWebKitSelectArtefact('webkit', [line], 1)).toEqual([line]);
  });

  it('keeps what stays in its order', () => {
    expect(withoutWebKitSelectArtefact('webkit', [OTHER, EVENT, LINE, EVENT, OTHER], 1)).toEqual([
      OTHER,
      EVENT,
      OTHER,
    ]);
  });

  it('never changes the list it was given', () => {
    const list = [EVENT, LINE];
    withoutWebKitSelectArtefact('webkit', list, 1);
    expect(list).toEqual([EVENT, LINE]);
  });
});
