import { ButtonLink, IconAlert, IconClock, Mark } from '@drefyn/ui/react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Answer, Eyebrow, Head } from '../views/calm.tsx';
import lockupInk from './marks/drefyn-lockup-ink.svg';
import lockupPaper from './marks/drefyn-lockup-paper.svg';
import githubBlack from './marks/github-black.svg';
import githubWhite from './marks/github-white.svg';
import googleDark from './marks/google-dark.svg';
import googleLight from './marks/google-light.svg';
import { PROVIDER_NAMES, type FormNotice, type Provider } from './outcomes.ts';
import './auth.css';

const pathOf = (image: unknown): string => (image as { src: string }).src;

export { Answer, Head };

interface FrameProps {
  readonly hosted: boolean;
  readonly label: string;
  readonly busy?: boolean | undefined;
  readonly children: ReactNode;
}

// The brand half sits after main in the DOM and takes the left by grid area, so it never
// changes the reading order, and it holds nothing focusable. A self hosted server has none.
export function AuthFrame({ hosted, label, busy, children }: FrameProps): ReactNode {
  return (
    <div className="auth" data-hosted={hosted ? '' : undefined}>
      <header className="auth-head">
        <a className="sr-only focus:not-sr-only" href="#main">
          Skip to content
        </a>
        <Link className="auth-lockup" href="/sign-in" aria-label="Drefyn, sign in">
          <img className="auth-only-light" src={pathOf(lockupInk)} alt="" width="109" height="32" />
          <img
            className="auth-only-dark"
            src={pathOf(lockupPaper)}
            alt=""
            width="109"
            height="32"
          />
        </Link>
      </header>
      <main
        className="auth-main"
        id="main"
        tabIndex={-1}
        aria-busy={busy === true ? true : undefined}
      >
        <div className="auth-margin">
          <Eyebrow>{label}</Eyebrow>
        </div>
        <div className="auth-content">{children}</div>
      </main>
      {hosted ? (
        <div className="auth-brand" aria-hidden="true">
          <div className="auth-dots auth-dots-1" />
          <div className="auth-dots auth-dots-2" />
          <div className="auth-dots auth-dots-3" />
          <div className="auth-dots auth-dots-4" />
          <div className="auth-brand-copy">
            <Mark size="lg" />
            <p className="auth-brand-line">
              Publish your docs, content and status page from one place.
            </p>
            <p className="auth-brand-support">Open source, on one account and one plan.</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// An unmodified official file each time. Google's holds a whole button, so the view fragment
// shows its G and leaves the file as Google ships it.
const G_VIEW = '#svgView(viewBox(10,10,20,20))';

function ProviderMark({ provider }: { provider: Provider }): ReactNode {
  const [light, dark] =
    provider === 'github'
      ? [pathOf(githubBlack), pathOf(githubWhite)]
      : [`${pathOf(googleLight)}${G_VIEW}`, `${pathOf(googleDark)}${G_VIEW}`];
  return (
    <>
      <img className="auth-only-light" src={light} alt="" width="20" height="20" />
      <img className="auth-only-dark" src={dark} alt="" width="20" height="20" />
    </>
  );
}

export function Providers({
  providers,
  next,
}: {
  providers: readonly Provider[];
  next?: string | undefined;
}): ReactNode {
  if (providers.length === 0) return null;
  const query = next === undefined || next === '' ? '' : `?next=${encodeURIComponent(next)}`;
  return (
    <div className="auth-providers">
      {providers.map((provider) => (
        // A plain anchor: the start route redirects off this origin.
        <a
          key={provider}
          className={`auth-provider auth-provider-${provider}`}
          href={`/auth/oauth/${provider}/start${query}`}
        >
          <ProviderMark provider={provider} />
          Continue with {PROVIDER_NAMES[provider]}
        </a>
      ))}
    </div>
  );
}

export const Or = (): ReactNode => (
  <p className="auth-or" aria-hidden="true">
    <span>or</span>
  </p>
);

function noticeWords(notice: FormNotice, others: string): readonly [string, ReactNode] {
  switch (notice.kind) {
    case 'unavailable':
      return [
        'Sign in is not answering. Nothing was sent.',
        <>
          Try again in a minute. If it keeps happening, give this reference to whoever runs this
          server: <code>{notice.reference}</code>
        </>,
      ];
    case 'not_saved':
      return [
        'That did not save.',
        <>
          Nothing changed. Try again in a minute. If it keeps happening, give this reference to
          whoever runs this server: <code>{notice.reference}</code>
        </>,
      ];
    case 'limited':
      return [
        'Too many tries from here.',
        <>
          You can try again in <span className="tabular-nums">{notice.minutes}</span>{' '}
          {notice.minutes === 1 ? 'minute' : 'minutes'}.{others}
        </>,
      ];
    // The limit counts refused tries too, so the words never claim how many were created.
    case 'day_limit':
      return [
        'That is the most tries for one day.',
        'New organizations are limited per day, and addresses that were taken count. You can try again tomorrow.',
      ];
    case 'expired':
      return [
        'This page was open for a while, so it needs a refresh.',
        <>
          Nothing was sent. <a href="">Refresh the page</a> and enter your address again.
        </>,
      ];
    case 'botcheck_down':
      return [
        'The check is not loading, so this is paused for a moment.',
        'Nothing was sent. Try again in a few minutes, or sign in with an email code.',
      ];
    case 'oauth_error':
      return [
        `${notice.provider} did not finish signing you in.`,
        'Nothing changed on your account. Try again, or sign in with your email address.',
      ];
    case 'oauth_unverified':
      return [
        `${notice.provider} has no confirmed email address for you.`,
        `We match accounts by a confirmed address, so we cannot tell which Drefyn account is yours. Confirm your primary address on ${notice.provider}, or sign in with email.`,
      ];
    case 'oauth_closed':
      return [
        'This server does not take sign ups.',
        'Accounts here start with an invitation from an organization.',
      ];
  }
}

// Not a failure of ours, so these get the clock and no broken gutter.
const NEUTRAL: ReadonlySet<FormNotice['kind']> = new Set(['limited', 'day_limit', 'expired']);

// Takes focus when it appears, so a failure is read at once and fields stay quiet.
export function Notice({
  notice,
  others = '',
}: {
  notice: FormNotice;
  others?: string;
}): ReactNode {
  const [title, detail] = noticeWords(notice, others);
  const neutral = NEUTRAL.has(notice.kind);
  return (
    <div
      className={neutral ? 'auth-notice' : 'auth-notice auth-notice-broken'}
      role={neutral ? 'status' : 'alert'}
      tabIndex={-1}
      data-notice=""
    >
      {neutral ? <IconClock /> : <IconAlert />}
      <div>
        <p className="auth-notice-title">{title}</p>
        <p>{detail}</p>
      </div>
    </div>
  );
}

export function FieldError({ id, children }: { id: string; children: string }): ReactNode {
  return (
    <p className="auth-field-error" id={id}>
      <IconAlert />
      <span>{children}</span>
    </p>
  );
}

interface CodeFieldProps {
  readonly id: string;
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly defaultValue?: string | undefined;
}

// One native input: paste, one time code autofill and typing with scripts off all work, and a
// screen reader meets one field, not eight.
export function CodeField({ id, hint, error, defaultValue }: CodeFieldProps): ReactNode {
  const described = [
    hint === undefined ? null : `${id}-hint`,
    error === undefined ? null : `${id}-error`,
  ]
    .filter((part) => part !== null)
    .join(' ');
  return (
    <div className="flex flex-col gap-4">
      <label className="auth-code-label" htmlFor={id}>
        8 digit code
      </label>
      {hint === undefined ? null : (
        <p className="auth-fine" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      <input
        className="auth-code"
        id={id}
        name="code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9 ]*"
        maxLength={9}
        spellCheck={false}
        required
        autoFocus
        defaultValue={defaultValue}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={described === '' ? undefined : described}
      />
      {error === undefined ? null : <FieldError id={`${id}-error`}>{error}</FieldError>}
    </div>
  );
}

export function SpokenCode({ code }: { code: string }): ReactNode {
  return (
    <p className="auth-code-show" role="img" aria-label={`Code: ${code.split('').join(' ')}`}>
      <span>{code.slice(0, 4)}</span>
      <span>{code.slice(4)}</span>
    </p>
  );
}

export function PrimaryLink({ href, children }: { href: string; children: ReactNode }): ReactNode {
  return (
    <ButtonLink href={href} variant="primary" size="lg">
      {children}
    </ButtonLink>
  );
}
