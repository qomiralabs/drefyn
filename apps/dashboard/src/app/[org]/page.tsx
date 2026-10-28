import { Badge, StatusPip } from '@drefyn/ui/react';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { PLACEHOLDER } from '../../fixtures/placeholder.ts';
import { guardOrganization } from '../../server/guard.ts';
import { NEEDS_YOU, needsYouSentence } from '../../fixtures/shell.ts';
import { IconLock } from '../../shell/icons.tsx';
import { Answer, Calm, Eyebrow, Head, Ranked, TextLink } from '../../views/calm.tsx';

const { organization } = PLACEHOLDER;
const org = organization.slug;

interface Params {
  params: Promise<{ org: string }>;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { name } = await guardOrganization((await params).org);
  return { title: `${name} overview` };
}

interface ProductRow {
  readonly product: string;
  readonly say: ReactNode;
  readonly detail: ReactNode;
  readonly href: string;
  readonly action: string;
}

const ROWS: readonly ProductRow[] = [
  {
    product: 'Docs',
    say: '3 of 50 pages in Payments API docs are out of date.',
    detail: 'Partner API docs is read only on the Starter plan.',
    href: `/${org}/docs/payments-api`,
    action: 'Review pages',
  },
  {
    product: 'Studio',
    say: 'Studio has no projects yet.',
    detail: 'Starter includes one Studio project. There is nothing to sign up for.',
    href: `/${org}/studio`,
    action: 'Open Studio',
  },
  {
    product: 'Status',
    say: (
      <>
        <Badge state="fresh">Everything is running</Badge> on status.acme.com.
      </>
    ),
    detail: (
      <>
        Checked from 6 regions <time dateTime="2026-10-27T14:19:20Z">40 seconds ago</time>.
      </>
    ),
    href: `/${org}/status`,
    action: 'Open status page',
  },
];

// How each kind of item is marked and explained on the overview.
const MARKS: Readonly<Record<string, ReactNode>> = {
  'review-pages': <StatusPip state="stale" label="Out of date" />,
  'read-only': (
    <span role="img" aria-label="Read only" className="inline-flex text-secondary">
      <IconLock />
    </span>
  ),
};

const DETAILS: Readonly<Record<string, string>> = {
  'review-pages': 'Docs. Your API changed on 24 Oct and these pages still show the old fields.',
  'read-only': 'Partner API docs is read only. Nothing was deleted.',
};

// The organization overview answers "does anything need me?" in one sentence, then one row
// per product, the ranked list and the plan line.
export default async function Overview({ params }: Params) {
  await guardOrganization((await params).org);
  return (
    <Calm>
      <Head>
        <Eyebrow>{organization.name}</Eyebrow>
        <Answer
          claim={needsYouSentence(NEEDS_YOU.length)}
          rest="Everything else is fresh and running."
        />
      </Head>
      <ul aria-label="Products" className="border-t border-rule">
        {ROWS.map((row) => (
          <li
            key={row.product}
            className="flex flex-col gap-8 border-b border-rule py-24 sm:flex-row sm:items-baseline sm:gap-16"
          >
            <p className="w-96 shrink-0 text-label text-secondary uppercase">{row.product}</p>
            <div className="flex min-w-0 flex-1 flex-col gap-4">
              <p className="text-body-m text-ink">{row.say}</p>
              <p className="text-caption text-secondary">{row.detail}</p>
            </div>
            <span className="shrink-0">
              <TextLink href={row.href}>{row.action}</TextLink>
            </span>
          </li>
        ))}
      </ul>
      <Ranked
        label="Needs you"
        items={NEEDS_YOU.map((item) => ({
          id: item.id,
          mark: MARKS[item.id] ?? null,
          title: item.title,
          href: item.href,
          detail: DETAILS[item.id] ?? item.where,
          when: item.when,
        }))}
      />
      <p className="text-body-s text-secondary">
        {organization.name} is on <span className="font-medium text-ink">{organization.plan}</span>:
        Docs, Studio and Status on one plan, <data value="1900">$19</data> a month.{' '}
        <data value="4">4</data> of <data value="5">5</data> seats used.{' '}
        <Link
          href={`/${org}/settings/plan`}
          className="text-accent-ink underline hover:text-accent-press focus-visible:focus-ring"
        >
          Plan and usage
        </Link>
      </p>
    </Calm>
  );
}
