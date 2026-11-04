'use client';
import type { ReactNode } from 'react';
import { makeOrganization, saveWelcome } from '../server/first-run-actions.ts';
import { useFocusOnChange } from './controls.tsx';
import {
  NoOrganizationScreen,
  OrganizationScreen,
  WelcomeScreen,
  type OrganizationProps,
  type WelcomeProps,
} from './first-run-screens.tsx';
import type { FormNotice } from './outcomes.ts';
import type { OrganizationState, WelcomeState } from './states.ts';
import { noticed, useForm } from './use-form.ts';

// A wrapper refusal reads as a form that did not save, not as sign in being down.
const unsaved = (notice: FormNotice | undefined): FormNotice | undefined =>
  notice?.kind === 'unavailable' ? { ...notice, kind: 'not_saved' } : notice;

export function WelcomeForm(props: Omit<WelcomeProps, 'action' | 'state'>): ReactNode {
  const [state, action] = useForm<WelcomeState>(saveWelcome, {});
  const { view, notice } = noticed(state, {});
  const focus = useFocusOnChange(state);
  const shown = unsaved(notice) ?? view.notice;
  return (
    <div ref={focus} className="contents">
      <WelcomeScreen
        {...props}
        action={action}
        state={shown === undefined ? view : { ...view, notice: shown }}
      />
    </div>
  );
}

export function OrganizationForm(props: Omit<OrganizationProps, 'action' | 'state'>): ReactNode {
  const [state, action] = useForm<OrganizationState>(makeOrganization, {});
  const { view, notice } = noticed(state, {});
  const focus = useFocusOnChange(state);
  const shown = unsaved(notice) ?? view.notice;
  if (view.closed === true) {
    return (
      <NoOrganizationScreen
        hosted={props.hosted}
        email={props.email}
        invitation={props.invitation}
      />
    );
  }
  return (
    <div ref={focus} className="contents">
      <OrganizationScreen
        {...props}
        action={action}
        state={shown === undefined ? view : { ...view, notice: shown }}
      />
    </div>
  );
}
