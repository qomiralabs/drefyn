import { ButtonLink } from '@drefyn/ui/react';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { PLACEHOLDER } from '../../../fixtures/placeholder.ts';
import { projectsOf } from '../../../fixtures/projects.ts';
import { PRODUCTS } from '../../../shell/products.ts';
import { parseShellPath, shellHref } from '../../../shell/route.ts';
import { Answer, Calm, Eyebrow, Head, Ranked } from '../../../views/calm.tsx';

interface Params {
  params: Promise<{ org: string; product: string }>;
}

function productFrom(org: string, product: string) {
  const location = parseShellPath(`/${org}/${product}`);
  const found = PRODUCTS.find((p) => p.id === location?.product);
  if (found === undefined) notFound();
  return found;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { org, product } = await params;
  return { title: productFrom(org, product).label };
}

// A product home. With one project it goes straight there; with several it lists them;
// with none it says how to start.
export default async function ProductHome({ params }: Params) {
  const { org, product: slug } = await params;
  const product = productFrom(org, slug);
  const projects = projectsOf(product.id);
  const only = projects.length === 1 ? projects[0] : undefined;
  if (only !== undefined) redirect(shellHref({ org, product: product.id, project: only.slug }));

  if (projects.length === 0) {
    return (
      <Calm>
        <Head>
          <Eyebrow>{product.label}</Eyebrow>
          <Answer
            claim={`No ${product.label} projects yet.`}
            rest={`${PLACEHOLDER.organization.plan} includes one, so there is nothing to sign up for.`}
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
          mark: null,
          title: p.name,
          href: shellHref({ org, product: product.id, project: p.slug }),
          detail: `${product.label} project`,
          when: null,
        }))}
      />
    </Calm>
  );
}
