import { ButtonLink } from '@drefyn/ui/react';
import type { ReactNode } from 'react';
import { shellHref } from '../shell/route.ts';
import type { ProductId } from '../shell/products.ts';
import { Answer, Calm, Evidence, Eyebrow, Head } from './calm.tsx';

interface Words {
  readonly claim: string;
  readonly rest: string;
  // A section of the project, each the first step in that product.
  readonly actions: readonly {
    readonly label: string;
    readonly section: string;
    readonly primary?: true;
  }[];
}

const READ_ONLY = 'Read only. Nothing was deleted.';

// No product feeds a project home yet, so every real project is the empty state of its
// product. These sentences are what stops the home claiming a freshness nobody checked.
const WORDS: Readonly<Record<ProductId, Words>> = {
  docs: {
    claim: 'No pages yet.',
    rest: 'Generate them from your repository, or write the first one.',
    actions: [
      { label: 'Generate from repository', section: 'settings', primary: true },
      { label: 'Write a page', section: 'pages' },
    ],
  },
  status: {
    claim: 'No monitors yet.',
    rest: 'Add one and this page says whether your service is running.',
    actions: [{ label: 'Add a monitor', section: 'monitors', primary: true }],
  },
  studio: {
    claim: 'Nothing in Studio yet.',
    rest: 'Your work shows here when Studio opens.',
    actions: [],
  },
};

export const projectAnswer = (product: ProductId, readOnly: boolean): string =>
  readOnly ? READ_ONLY : WORDS[product].claim;

export function ProjectHomeEmpty({
  org,
  project,
}: {
  org: string;
  project: {
    readonly slug: string;
    readonly name: string;
    readonly product: ProductId;
    readonly readOnly: boolean;
  };
}): ReactNode {
  const { claim, rest, actions } = WORDS[project.product];
  const href = (section: string) =>
    shellHref({ org, product: project.product, project: project.slug, section });
  return (
    <Calm>
      <Head>
        <Eyebrow>{project.name}</Eyebrow>
        <Answer claim={claim} rest={rest} />
        {project.readOnly ? <Evidence>{READ_ONLY}</Evidence> : null}
      </Head>
      {project.readOnly || actions.length === 0 ? null : (
        <div className="flex flex-wrap gap-8">
          {actions.map((action) => (
            <ButtonLink
              key={action.section}
              variant={action.primary === true ? 'primary' : 'secondary'}
              href={href(action.section)}
            >
              {action.label}
            </ButtonLink>
          ))}
        </div>
      )}
    </Calm>
  );
}
