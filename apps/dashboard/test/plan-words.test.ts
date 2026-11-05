import { TIERS, limitFor, type Tier } from '@drefyn/entitlements';
import { describe, expect, it } from 'vitest';
import {
  includedSentence,
  projectCountSentence,
  seatMeta,
  seatsSentence,
} from '../src/server/plan-words.ts';

describe('seat words', () => {
  it('counts against the plan where it has a limit', () => {
    expect(seatsSentence({ used: 4, limit: 5 })).toBe('4 of 5 seats used.');
    expect(seatMeta({ used: 4, limit: 5 })).toBe('4 of 5');
  });

  it('gives only the count where the plan has none', () => {
    expect(seatsSentence({ used: 1, limit: 'unlimited' })).toBe('1 seat used.');
    expect(seatsSentence({ used: 7, limit: 'unlimited' })).toBe('7 seats used.');
    expect(seatMeta({ used: 7, limit: 'unlimited' })).toBe('7');
  });
});

describe('project counts', () => {
  it('names what each product holds', () => {
    expect(projectCountSentence('docs', 0)).toBe('No Docs projects yet.');
    expect(projectCountSentence('docs', 1)).toBe('1 Docs project.');
    expect(projectCountSentence('status', 1)).toBe('1 status page.');
    expect(projectCountSentence('status', 3)).toBe('3 status pages.');
  });
});

describe('what a plan includes', () => {
  it('reads the entitlements table, so two tiers say different things', () => {
    const say = (tier: Tier) => includedSentence(tier, 'docs');
    expect(say('free')).toBe('Free includes 1 Docs project.');
    expect(say('growth')).toBe('Growth includes 3 Docs projects.');
    expect(say('self_hosted')).toBe('Self hosted has no limit on Docs projects.');
  });

  it('names status pages for what they are', () => {
    expect(includedSentence('growth', 'status')).toBe('Growth includes 5 status pages.');
  });

  it.each(TIERS)('moves with the table on %s', (tier) => {
    const limit = limitFor(tier, 'org.studio_projects');
    expect(includedSentence(tier, 'studio')).toContain(
      limit === 'unlimited' ? 'no limit' : String(limit),
    );
  });
});
