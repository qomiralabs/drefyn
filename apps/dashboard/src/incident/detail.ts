// What the cockpit shows about an incident. Fixture words until the Status API exists; it
// loads with the cockpit, so no route pays for it up front.
export interface IncidentDetail {
  readonly agreement: string;
  readonly affected: readonly {
    readonly name: string;
    readonly state: 'broken' | 'stale' | 'fresh';
    readonly word: string;
    readonly note: string;
  }[];
  readonly timeline: readonly {
    readonly at: string;
    readonly text: string;
  }[];
  readonly draft: {
    readonly draftedAt: string;
    readonly text: string;
    readonly reach: string;
  };
  readonly reach: {
    readonly subscribers: number;
    readonly channels: string;
    readonly readers: string;
  };
  readonly regions: readonly {
    readonly name: string;
    readonly failing: boolean;
    readonly p75Ms: number;
  }[];
}

export const FIXTURE_DETAIL: IncidentDetail = {
  agreement: '4 of 6 regions agree. 18 minutes so far.',
  affected: [
    {
      name: 'Payments API',
      state: 'broken',
      word: 'Partial outage',
      note: '4 of 6 regions, p75 1,204 ms',
    },
    { name: 'Webhooks', state: 'stale', word: 'Degraded', note: '3 of 6 regions, p75 640 ms' },
    {
      name: 'Checkout',
      state: 'fresh',
      word: 'Operational',
      note: 'Depends on Payments API; watching',
    },
  ],
  timeline: [
    { at: '2026-10-27T14:02:00Z', text: 'First errors seen from Frankfurt.' },
    {
      at: '2026-10-27T14:04:00Z',
      text: 'Confirmed by 4 regions. Payments API set to partial outage, as your team allowed.',
    },
    {
      at: '2026-10-27T14:09:00Z',
      text: 'Draft update ready for review. 11 minutes without a public update.',
    },
  ],
  draft: {
    draftedAt: '2026-10-27T14:09:00Z',
    text: 'We are seeing errors on the Payments API for customers in Europe since 14:02 UTC. Card payments may fail or take longer than usual. Other regions are not affected. We are investigating and will post again by 14:45 UTC.',
    reach:
      'Publishing posts to status.acme.com, shows a banner on 6 linked docs pages and notifies 12,408 subscribers.',
  },
  reach: {
    subscribers: 12408,
    channels: 'Email 11,950, SMS 312, Slack 146.',
    readers: '38 reading affected docs now',
  },
  regions: [
    { name: 'Frankfurt', failing: true, p75Ms: 1204 },
    { name: 'London', failing: true, p75Ms: 1180 },
    { name: 'Paris', failing: true, p75Ms: 1322 },
    { name: 'Stockholm', failing: true, p75Ms: 990 },
    { name: 'Virginia', failing: false, p75Ms: 182 },
    { name: 'Oregon', failing: false, p75Ms: 176 },
  ],
};
