'use client';
import { Button, TextField } from '@drefyn/ui/react';
import { useRouter } from 'next/navigation';
import { useState, type SyntheticEvent, type ReactNode } from 'react';
import { makeOrganization } from '../server/settings-actions.ts';
import { Answer, Head } from '../auth/parts.tsx';
import { problemWords, settle, type Problem } from './results.ts';

const SLUG_WORDS = /[^a-z0-9]+/g;
const slugOf = (name: string) => name.toLowerCase().replace(SLUG_WORDS, '-').replace(/^-|-$/g, '');

export function NewOrganizationScreen({
  origin,
  limited = false,
  taken = null,
}: {
  origin: string;
  limited?: boolean;
  taken?: string | null;
}): ReactNode {
  const router = useRouter();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState(taken ?? '');
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [slugError, setSlugError] = useState<string | undefined>(
    taken === null ? undefined : `${origin}/${taken} is taken.`,
  );
  const [nameError, setNameError] = useState<string | undefined>();
  const stopped = limited || problem?.kind === 'limited';
  const host = origin.replace(/^https?:\/\//, '');

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (stopped) return;
    setBusy(true);
    setProblem(null);
    setSlugError(undefined);
    setNameError(undefined);
    const made = settle(await makeOrganization({ name, slug }));
    setBusy(false);
    if (made.ok) {
      router.push(`/${made.value}`);
      return;
    }
    const { problem: failure } = made;
    if (failure.kind === 'refused' && failure.code === 'AUTH_SLUG_TAKEN') {
      setSlugError(`${host}/${slug} is taken. Try another.`);
    } else if (failure.kind === 'refused' && failure.code === 'AUTH_SLUG_INVALID') {
      setSlugError('Use lowercase letters, numbers and hyphens.');
    } else if (failure.kind === 'refused' && failure.code === 'AUTH_INPUT_INVALID') {
      setNameError('Use up to 100 characters, with no web addresses.');
    } else {
      setProblem(failure);
    }
  }

  return (
    <>
      <Head>
        <Answer
          claim="Name your organization."
          rest="It holds your projects, your people and one plan for all three products."
        />
      </Head>
      {stopped ? (
        <div role="status" className="auth-notice" data-notice="" tabIndex={-1}>
          <div>
            <p className="auth-notice-title">
              You have created the most organizations for one day.
            </p>
            <p>You can create another tomorrow.</p>
          </div>
        </div>
      ) : problem === null ? null : (
        <div role="alert" className="auth-notice auth-notice-broken" data-notice="" tabIndex={-1}>
          <p>{problemWords(problem)}</p>
        </div>
      )}
      <form onSubmit={(event) => void submit(event)} className="auth-form">
        <TextField
          id="organization-name"
          name="name"
          label="Name"
          size="lg"
          autoComplete="organization"
          description="Your company or team. Web addresses are not allowed in names."
          value={name}
          required
          onChange={(value) => {
            setName(value);
            if (!edited) setSlug(slugOf(value));
          }}
          {...(nameError === undefined ? {} : { error: nameError })}
        />
        <TextField
          id="organization-slug"
          name="slug"
          label="Address"
          size="lg"
          spellCheck={false}
          autoCapitalize="none"
          description={`${host}/${slug === '' ? 'your-address' : slug}. Lowercase letters, numbers and hyphens. Anyone can see whether an address is taken, and nothing else.`}
          value={slug}
          required
          onChange={(value) => {
            setSlug(value);
            setEdited(true);
          }}
          {...(slugError === undefined ? {} : { error: slugError })}
        />
        <span className="grid">
          <Button
            type="submit"
            variant="primary"
            size="lg"
            busy={busy}
            busyLabel="Creating"
            disabled={stopped}
          >
            Create organization
          </Button>
        </span>
      </form>
    </>
  );
}
