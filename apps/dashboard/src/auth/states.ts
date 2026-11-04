import type { FormNotice } from './outcomes.ts';

// What each form's action hands back. Values only, so with scripts off the same state can
// render the page after a plain post.

export interface StartState {
  readonly email?: string;
  readonly invalid?: boolean;
  readonly notice?: FormNotice;
}

export interface TypedCodeState {
  readonly code?: string;
  readonly problem?: 'wrong' | 'expired' | 'closed';
  readonly notice?: FormNotice;
}

export type LinkState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'gone' }
  | { readonly kind: 'elsewhere'; readonly code: string }
  | { readonly kind: 'failed'; readonly notice: FormNotice }
  | {
      readonly kind: 'here';
      readonly email: string;
      readonly purpose: string;
      readonly challenge: string;
      readonly code: string;
    }
  | { readonly kind: 'choose'; readonly challenge: string; readonly code: string };

export interface PasswordState {
  readonly email?: string;
  readonly wrong?: boolean;
  readonly notice?: FormNotice;
}

export type ResetState =
  | {
      readonly step: 'ask';
      readonly email?: string;
      readonly invalid?: boolean;
      readonly expired?: boolean;
      readonly notice?: FormNotice;
    }
  | { readonly step: 'code'; readonly email: string; readonly wrong?: boolean }
  | {
      readonly step: 'choose';
      readonly code: string;
      readonly challenge: string;
      readonly rules?: readonly string[];
      readonly breached?: boolean;
      readonly notice?: FormNotice;
    }
  | { readonly step: 'saved'; readonly email: string; readonly returnTo: string };

export interface WelcomeState {
  readonly name?: string;
  readonly problem?: 'name' | 'password' | 'breached' | 'late';
  readonly rules?: readonly string[];
  readonly notice?: FormNotice;
}

export interface OrganizationState {
  readonly name?: string;
  readonly problem?: 'name';
  readonly limited?: boolean;
  // Sign up closed since the page was drawn, or a post that never came from it.
  readonly closed?: boolean;
  readonly notice?: FormNotice;
}

export type CliState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'failed'; readonly notice: FormNotice };

export interface InvitationFacts {
  readonly organizationName: string;
  readonly inviterName: string;
  readonly email: string;
  readonly role: string;
  readonly projectRole: string | null;
  readonly expiresAt: string;
  readonly blockHref: string;
}

export type InviteState =
  | { readonly kind: 'reading' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'failed'; readonly notice: FormNotice }
  | ({ readonly kind: 'signed_out' } & InvitationFacts)
  | ({ readonly kind: 'match'; readonly token: string } & InvitationFacts)
  | ({ readonly kind: 'mismatch'; readonly signedInAs: string } & InvitationFacts);

export type BlockState =
  | { readonly kind: 'reading' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'failed'; readonly notice: FormNotice }
  | { readonly kind: 'ask'; readonly organizationName: string; readonly token: string }
  | { readonly kind: 'done'; readonly organizationName: string };
