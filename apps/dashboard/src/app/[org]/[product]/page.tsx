import type { AccessContext } from '@drefyn/auth';
import { ButtonLink, IconLock } from '@drefyn/ui/react';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { guardOrganization } from '../../../server/guard.ts';
import { includedSentence } from '../../../server/plan-words.ts';
import { projectsInReach, reachesProduct } from '../../../server/projects.ts';
import { PRODUCTS } from '../../../shell/products.ts';
import { parseShellPath, shellHref } from '../../../shell/route.ts';
import { Answer, Calm, Eyebrow, Head, Ranked } from '../../../views/calm.tsx';
import { projectAnswer } from '../../../views/project-home.tsx';

interface Params {
  params: Promise<{ org: string; product: string }>;
}

async function productFrom(access: AccessContext, org: string, product: string) {
  const location = parseShellPath(`/${org}/${product}`);
  const found = PRODUCTS.find((p) => p.id === location?.product);
  if (found === undefined) notFound();
  const projects = await projectsInReach(access);
  if (!reachesProduct(access, projects, found.id)) notFound();
  return { product: found, projects: projects.filter((p) => p.product === found.id) };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { org, product } = await params;
  const { access } = await guardOrganization(org);
  return { title: (await productFrom(access, org, product)).product.label };
}

// A product home. With one project it goes straight there; with several it lists them;
// with none it says how to start.
export default async function ProductHome({ params }: Params) {
  const { org, product: slug } = await params;
  const { access } = await guardOrganization(org);
  const { product, projects } = await productFrom(access, org, slug);
  const only = projects.length === 1 ? projects[0] : undefined;
  if (only !== undefined) redirect(shellHref({ org, product: product.id, project: only.slug }));

  if (projects.length === 0) {
    return (
      <Calm>
        <Head>
          <Eyebrow>{product.label}</Eyebrow>
          <Answer
            claim={`No ${product.label} projects yet.`}
            rest={includedSentence(access.tier, product.id)}
          />
        </Head>
        <div className="flex flex-wrap gap-8">
          <ButtonLink variant="primary" href={`/${org}/settings`}>
            Create a project
          </ButtonLink>
        </div>
      </Calm>
    );
  }

  return (
    <Calm>
      <Head>
        <Eyebrow>{product.label}</Eyebrow>
        <Answer
          claim={`${projects.length} ${product.label} projects.`}
          rest="Pick one to see whether it is fresh."
        />
      </Head>
      <Ranked
        label="Projects"
        items={projects.map((p) => ({
          id: p.slug,
          mark: p.readOnly ? (
            <span role="img" aria-label="Read only" className="inline-flex text-secondary">
              <IconLock />
            </span>
          ) : (
            // Keeps every row's name on one line with the marked ones.
            <span aria-hidden="true" className="inline-block size-icon-sm" />
          ),
          title: p.name,
          href: shellHref({ org, product: product.id, project: p.slug }),
          detail: projectAnswer(p.product, p.readOnly),
          when: null,
        }))}
      />
    </Calm>
  );
}
