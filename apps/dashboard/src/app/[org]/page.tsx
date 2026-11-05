import { IconLock } from '@drefyn/ui/react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { guardOrganization } from '../../server/guard.ts';
import { includedSentence, projectCountSentence, seatsSentence } from '../../server/plan-words.ts';
import { projectsInReach, reachesProduct } from '../../server/projects.ts';
import { PLAN_LABELS, readShell } from '../../server/shell-data.ts';
import { needsYouSentence } from '../../shell/needs-you.ts';
import { PRODUCTS, type ProductId } from '../../shell/products.ts';
import { Answer, Calm, Eyebrow, Head, TextLink } from '../../views/calm.tsx';

interface Params {
  params: Promise<{ org: string }>;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { view } = await guardOrganization((await params).org);
  return { title: `${view.organizationName} overview` };
}

// The organization overview answers "does anything need me?" in one sentence, then one row
// per product the reader can open, and the plan line. Reading the projects here and not from
// the shell lets a failed read reach the error page instead of showing as no projects.
export default async function Overview({ params }: Params) {
  const guarded = await guardOrganization((await params).org);
  const { access, view } = guarded;
  const org = view.organizationSlug;
  const [projects, shell] = await Promise.all([projectsInReach(access), readShell(guarded)]);
  const rows = PRODUCTS.filter((p) => reachesProduct(access, projects, p.id));
  const held = (product: ProductId) => projects.filter((p) => p.product === product);
  return (
    <Calm>
      <Head>
        <Eyebrow>{view.organizationName}</Eyebrow>
        <Answer
          claim={needsYouSentence(shell.inbox.length)}
          rest="Each product reports here as it opens."
        />
      </Head>
      {rows.length === 0 ? (
        <p className="border-t border-rule pt-24 text-body-m text-ink">
          You have no projects here yet.{' '}
          <span className="text-secondary">An owner or admin can give you access.</span>
        </p>
      ) : (
        <ul aria-label="Products" className="border-t border-rule">
          {rows.map((product) => (
            <li
              key={product.id}
              className="flex flex-col gap-8 border-b border-rule py-24 sm:flex-row sm:items-baseline sm:gap-16"
            >
              <p className="w-96 shrink-0 text-label text-secondary uppercase">{product.label}</p>
              <div className="flex min-w-0 flex-1 flex-col gap-4">
                <p className="flex items-center gap-8 text-body-m text-ink">
                  {projectCountSentence(product.id, held(product.id).length)}
                  {held(product.id).some((p) => p.readOnly) ? (
                    <span role="img" aria-label="Read only" className="inline-flex text-secondary">
                      <IconLock />
                    </span>
                  ) : null}
                </p>
                <p className="text-caption text-secondary">
                  {includedSentence(access.tier, product.id)}
                </p>
              </div>
              <span className="shrink-0">
                <TextLink href={`/${org}/${product.id}`}>{`Open ${product.label}`}</TextLink>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-body-s text-secondary">
        {view.organizationName} is on{' '}
        <span className="font-medium text-ink">{PLAN_LABELS[access.tier]}</span>: Docs, Studio and
        Status on one plan.{shell.seats === null ? ' ' : ` ${seatsSentence(shell.seats)} `}
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
