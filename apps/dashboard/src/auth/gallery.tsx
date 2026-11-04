import type { ReactNode } from 'react';
import { NoOrganizationScreen, OrganizationScreen, WelcomeScreen } from './first-run-screens.tsx';
import { BlockScreen, CliScreen, InviteScreen } from './outcome-screens.tsx';
import type { FormNotice, Provider } from './outcomes.ts';
import { AuthFrame } from './parts.tsx';
import {
  ChoosePassword,
  CodeElsewhere,
  ContinueAs,
  LinkScreen,
  PasswordScreen,
  Reading,
  ResetScreen,
  SignInScreen,
  SignUpScreen,
  TypedCode,
} from './screens.tsx';
import type { InvitationFacts } from './states.ts';

const EMAIL = 'maya@acme.dev';
const PROVIDERS: readonly Provider[] = ['github', 'google'];
const FACTS: InvitationFacts = {
  organizationName: 'Acme',
  inviterName: 'Priya Shah',
  email: 'jordan@acme.dev',
  role: 'member',
  projectRole: 'editor',
  expiresAt: '2026-11-06T14:20:00.000Z',
  blockHref: '/invite/block#token',
};
const UNAVAILABLE: FormNotice = { kind: 'unavailable', reference: 'ref_0a1b2c3d4e5f' };
const NOT_SAVED: FormNotice = { kind: 'not_saved', reference: 'ref_0a1b2c3d4e5f' };
const LIMITED: FormNotice = { kind: 'limited', minutes: 14 };
const shared = (hosted: boolean) => ({ hosted, csrf: '' });

const INVITED = { organizationName: 'Acme', inviterName: 'Priya Shah' };

type Screen = (hosted: boolean) => ReactNode;

function welcome(overrides: Partial<Parameters<typeof WelcomeScreen>[0]> = {}): Screen {
  const Page = (hosted: boolean) => (
    <WelcomeScreen
      hosted={hosted}
      email={EMAIL}
      next=""
      passwordOn
      invitation={null}
      {...overrides}
    />
  );
  return Page;
}

function organization(overrides: Partial<Parameters<typeof OrganizationScreen>[0]> = {}): Screen {
  const Page = (hosted: boolean) => (
    <OrganizationScreen
      hosted={hosted}
      email={EMAIL}
      host="app.drefyn.com"
      member={false}
      invitation={null}
      {...overrides}
    />
  );
  return Page;
}

const TYPED_ORG = { name: 'Acme', slug: 'acme' };

function signIn(overrides: Partial<Parameters<typeof SignInScreen>[0]> = {}): Screen {
  const Page = (hosted: boolean) => (
    <SignInScreen
      {...shared(hosted)}
      providers={PROVIDERS}
      emailOn
      passwordOn
      signUp="open"
      {...overrides}
    />
  );
  return Page;
}

function verify(child: ReactNode): Screen {
  const Page = (hosted: boolean) => (
    <AuthFrame hosted={hosted} label="Sign in">
      {child}
    </AuthFrame>
  );
  return Page;
}

const typed = (extra: Partial<Parameters<typeof TypedCode>[0]> = {}) => (
  <TypedCode {...shared(true)} email={EMAIL} fromSignUp={false} {...extra} />
);

const CHOOSE = { step: 'choose', code: '48210937', challenge: '' } as const;

// Every state of every signed out page, drawn from the screens with fixed words, so visual,
// axe and keyboard checks reach the failures a healthy stack never shows.
export const STATES: Readonly<Record<string, Readonly<Record<string, Screen>>>> = {
  'sign-in': {
    ready: signIn(),
    'email-only': signIn({ providers: [] }),
    invalid: signIn({ invalid: true, email: 'maya@acme' }),
    unavailable: signIn({ notice: UNAVAILABLE }),
    limited: signIn({ notice: LIMITED }),
    expired: signIn({ notice: { kind: 'expired' } }),
    'oauth-error': signIn({ notice: { kind: 'oauth_error', provider: 'GitHub' } }),
    'oauth-unverified': signIn({ notice: { kind: 'oauth_unverified', provider: 'GitHub' } }),
    none: signIn({ providers: [], emailOn: false }),
  },
  'sign-up': {
    ready: (h) => <SignUpScreen {...shared(h)} state="ready" providers={PROVIDERS} />,
    closed: (h) => <SignUpScreen {...shared(h)} state="closed" providers={PROVIDERS} />,
    'invite-only': (h) => <SignUpScreen {...shared(h)} state="invite_only" providers={[]} />,
    'botcheck-down': (h) => (
      <SignUpScreen
        {...shared(h)}
        state="ready"
        providers={PROVIDERS}
        notice={{ kind: 'botcheck_down' }}
      />
    ),
  },
  verify: {
    ready: verify(typed()),
    wrong: verify(typed({ problem: 'wrong', code: '48210936' })),
    expired: verify(typed({ problem: 'expired' })),
    link: verify(
      <ContinueAs action={undefined} csrf="" email={EMAIL} challenge="" code="48210937" />,
    ),
    elsewhere: verify(<CodeElsewhere code="48210937" />),
    reading: verify(<Reading title="Signing you in" />),
    'choose-password': verify(
      <ChoosePassword action={undefined} csrf="" code="48210937" challenge="" />,
    ),
  },
  password: {
    ready: (h) => <PasswordScreen {...shared(h)} providers={PROVIDERS} />,
    wrong: (h) => <PasswordScreen {...shared(h)} providers={PROVIDERS} wrong email={EMAIL} />,
    limited: (h) => <PasswordScreen {...shared(h)} providers={PROVIDERS} notice={LIMITED} />,
    'botcheck-down': (h) => (
      <PasswordScreen {...shared(h)} providers={PROVIDERS} notice={{ kind: 'botcheck_down' }} />
    ),
  },
  reset: {
    ask: (h) => <ResetScreen {...shared(h)} state={{ step: 'ask' }} />,
    code: (h) => <ResetScreen {...shared(h)} state={{ step: 'code', email: EMAIL }} />,
    choose: (h) => <ResetScreen {...shared(h)} state={CHOOSE} />,
    refused: (h) => <ResetScreen {...shared(h)} state={{ ...CHOOSE, rules: ['keyboard_row'] }} />,
    breached: (h) => <ResetScreen {...shared(h)} state={{ ...CHOOSE, breached: true }} />,
    saved: (h) => (
      <ResetScreen {...shared(h)} state={{ step: 'saved', email: EMAIL, returnTo: '/' }} />
    ),
  },
  link: {
    ready: (h) => <LinkScreen {...shared(h)} email={EMAIL} provider="GitHub" />,
    wrong: (h) => (
      <LinkScreen {...shared(h)} email={EMAIL} provider="GitHub" code="11902274" wrong />
    ),
  },
  cli: {
    invalid: (h) => <CliScreen {...shared(h)} view={{ kind: 'invalid' }} />,
    failed: (h) => <CliScreen {...shared(h)} view={{ kind: 'failed', notice: UNAVAILABLE }} />,
  },
  welcome: {
    ready: welcome(),
    invited: welcome({ invitation: INVITED }),
    'email-only': welcome({ passwordOn: false }),
    name: welcome({ state: { problem: 'name', name: 'acme.dev' } }),
    password: welcome({ state: { problem: 'password', rules: ['too_short'], name: 'Maya' } }),
    breached: welcome({ state: { problem: 'breached', name: 'Maya' } }),
    late: welcome({ state: { problem: 'late', name: 'Maya' } }),
    failed: welcome({ state: { notice: NOT_SAVED, name: 'Maya' } }),
  },
  organization: {
    ready: organization(),
    taken: organization({ state: { ...TYPED_ORG, problem: 'taken' } }),
    address: organization({ state: { name: 'Acme', slug: 'Acme Inc', problem: 'address' } }),
    name: organization({ state: { name: 'acme.dev', slug: 'acme', problem: 'name' } }),
    limited: organization({ state: { ...TYPED_ORG, limited: true } }),
    failed: organization({ state: { ...TYPED_ORG, notice: NOT_SAVED } }),
    invited: organization({ invitation: INVITED }),
    another: organization({ member: true }),
    none: (h) => <NoOrganizationScreen hosted={h} email={EMAIL} invitation={null} />,
    'none-invited': (h) => <NoOrganizationScreen hosted={h} email={EMAIL} invitation={INVITED} />,
  },
  invite: {
    reading: (h) => <InviteScreen {...shared(h)} view={{ kind: 'reading' }} />,
    'signed-out': (h) => <InviteScreen {...shared(h)} view={{ kind: 'signed_out', ...FACTS }} />,
    failed: (h) => <InviteScreen {...shared(h)} view={{ kind: 'failed', notice: UNAVAILABLE }} />,
    match: (h) => <InviteScreen {...shared(h)} view={{ kind: 'match', token: 't', ...FACTS }} />,
    mismatch: (h) => (
      <InviteScreen
        {...shared(h)}
        view={{ kind: 'mismatch', signedInAs: 'jordan.lee@example.dev', ...FACTS }}
      />
    ),
    invalid: (h) => <InviteScreen {...shared(h)} view={{ kind: 'invalid' }} />,
  },
  block: {
    reading: (h) => <BlockScreen {...shared(h)} view={{ kind: 'reading' }} />,
    ask: (h) => (
      <BlockScreen {...shared(h)} view={{ kind: 'ask', organizationName: 'Acme', token: 't' }} />
    ),
    done: (h) => <BlockScreen {...shared(h)} view={{ kind: 'done', organizationName: 'Acme' }} />,
    invalid: (h) => <BlockScreen {...shared(h)} view={{ kind: 'invalid' }} />,
  },
};
