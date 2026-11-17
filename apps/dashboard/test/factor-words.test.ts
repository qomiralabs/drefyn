import { describe, expect, it } from 'vitest';
import {
  factorDetail,
  factorNoticeFrom,
  factorNoticeWords,
  showFactorRow,
  FACTOR_PROBLEM_WORDS,
} from '../src/settings/factor-words.ts';

const DASHES = new RegExp(`[${String.fromCodePoint(0x2013, 0x2014)}]`);

describe('factorNoticeFrom', () => {
  it('reads every word the routes send back', () => {
    for (const problem of FACTOR_PROBLEM_WORDS) {
      expect(factorNoticeFrom({ factor: problem })?.problem).toBe(problem);
    }
  });

  it.each([{}, { factor: 'nope' }, { factor: '' }, { factor: ['<b>'] }])(
    'shows nothing for %j',
    (query) => {
      expect(factorNoticeFrom(query)).toBeNull();
    },
  );

  it('takes a retry time only as a small whole number', () => {
    expect(factorNoticeFrom({ factor: 'limited', retry: '14' })).toEqual({
      problem: 'limited',
      minutes: 14,
    });
    for (const retry of ['0', '-3', '1e3', '99999', 'soon', undefined]) {
      expect(factorNoticeFrom({ factor: 'limited', retry })).toEqual({
        problem: 'limited',
        minutes: 1,
      });
    }
  });

  // A link cannot put its own words on the page through the reference.
  it('takes a reference only in its own shape', () => {
    expect(factorNoticeFrom({ factor: 'failed', ref: 'ref_0a1b2c3d4e5f' })).toEqual({
      problem: 'failed',
      reference: 'ref_0a1b2c3d4e5f',
    });
    expect(factorNoticeFrom({ factor: 'failed', ref: 'call 555 0100' })).toEqual({
      problem: 'failed',
      reference: null,
    });
  });
});

describe('factorNoticeWords', () => {
  it('has plain words for every notice, with no dashes', () => {
    for (const problem of FACTOR_PROBLEM_WORDS) {
      const notice = factorNoticeFrom({ factor: problem, retry: '2', ref: 'ref_0a1b2c3d4e5f' });
      expect(notice).not.toBeNull();
      if (notice === null) continue;
      const [title, detail] = factorNoticeWords(notice);
      expect(title.length).toBeGreaterThan(0);
      expect(`${title} ${detail}`).not.toMatch(DASHES);
    }
  });

  it('tells a limited person when to retry, and that a recovery code still works', () => {
    const [, detail] = factorNoticeWords({ problem: 'limited', minutes: 3 });
    expect(detail).toBe('You can try again in 3 minutes. A recovery code still works.');
    expect(factorNoticeWords({ problem: 'limited', minutes: 1 })[1]).toContain('1 minute.');
  });

  it('says how to confirm when a young password would not count', () => {
    expect(factorNoticeWords({ problem: 'confirm' })[1]).toContain('email code');
  });
});

describe('the row', () => {
  it('says how many recovery codes are left', () => {
    expect(factorDetail({ available: true, enrolled: true, recoveryCodesLeft: 1 })).toBe(
      'On. 1 recovery code left.',
    );
    expect(factorDetail({ available: true, enrolled: true, recoveryCodesLeft: 8 })).toBe(
      'On. 8 recovery codes left.',
    );
    expect(factorDetail({ available: true, enrolled: true, recoveryCodesLeft: 0 })).toContain(
      'make new ones',
    );
    expect(factorDetail({ available: true, enrolled: false, recoveryCodesLeft: 0 })).toMatch(
      /^Off\./,
    );
    expect(factorDetail('failed')).toContain('Reload');
  });

  // The flag gates enrolment only: someone enrolled always sees the factor to manage it.
  it('hides enrolment with the flag off, never a factor someone has', () => {
    expect(showFactorRow({ available: false, enrolled: false, recoveryCodesLeft: 0 })).toBe(false);
    expect(showFactorRow({ available: false, enrolled: true, recoveryCodesLeft: 4 })).toBe(true);
    expect(showFactorRow({ available: true, enrolled: false, recoveryCodesLeft: 0 })).toBe(true);
    expect(showFactorRow('failed')).toBe(true);
    expect(showFactorRow(null)).toBe(false);
  });
});
