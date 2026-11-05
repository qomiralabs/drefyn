import { Badge, ButtonLink } from '@drefyn/ui/react';
import type { ReactNode } from 'react';
import { Answer, Calm, Evidence, Eyebrow, Head } from './calm.tsx';
import { TryAgain } from './try-again.tsx';

// The shell stays around this, so says what still works and gives a way to report it.
export function CouldNotLoad({
  eyebrow,
  what,
  rest,
  reference,
  reset,
}: {
  eyebrow: string;
  what: string;
  rest: string;
  reference: string | undefined;
  reset?: () => void;
}): ReactNode {
  return (
    <Calm>
      <Head>
        <Eyebrow>{eyebrow}</Eyebrow>
        <Badge state="broken">Could not load</Badge>
        <Answer claim={`We could not load ${what}.`} rest={rest} />
        {reference === undefined ? null : (
          <Evidence>
            If it keeps happening, send us this reference:{' '}
            <code className="font-mono text-code text-ink">{reference}</code>
          </Evidence>
        )}
      </Head>
      <div className="flex flex-wrap items-center gap-8">
        <TryAgain {...(reset === undefined ? {} : { reset })} />
        <ButtonLink variant="quiet" href="https://status.drefyn.com">
          Check status.drefyn.com
        </ButtonLink>
      </div>
    </Calm>
  );
}
