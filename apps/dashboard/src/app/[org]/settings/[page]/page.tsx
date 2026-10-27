import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Working } from '../../../../views/working.tsx';

const PAGES = {
  plan: {
    title: 'Plan and usage',
    caption: 'Starter covers Docs, Studio and Status. $19 a month, renews 1 Nov.',
  },
  members: { title: 'Members', caption: '4 of 5 seats used' },
} as const;

interface Params {
  params: Promise<{ org: string; page: string }>;
}

function pageFrom(slug: string) {
  const entry = Object.entries(PAGES).find(([key]) => key === slug)?.[1];
  if (entry === undefined) notFound();
  return entry;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return { title: pageFrom((await params).page).title };
}

export default async function SettingsPage({ params }: Params) {
  const page = pageFrom((await params).page);
  return (
    <Working title={page.title} caption={page.caption}>
      <p className="max-w-measure text-body-s text-secondary">
        This view arrives with the billing and members work.
      </p>
    </Working>
  );
}
