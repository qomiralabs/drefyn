'use client';
import { useActionState } from 'react';
import { isRefusal, refusalNotice } from './outcomes.ts';

export interface Refused {
  readonly ok: false;
  readonly code: string;
}

// The server reference goes straight to useActionState, which is what keeps these forms
// working with scripts off. Stated here because React cannot infer the payload from it.
export function useForm<T extends object>(
  action: (state: unknown, form: FormData) => Promise<T | Refused>,
  initial: T,
): [T | Refused, (form: FormData) => void, boolean] {
  const start = initial as Awaited<T | Refused>;
  return useActionState<T | Refused, FormData>(action, start);
}

// A refusal comes back in place of the form's state, with scripts on or off. Its code is a
// fixed word, so it can stand as the reference a person passes on.
export function noticed<T extends object>(state: T | Refused, empty: T) {
  if (isRefusal(state)) return { view: empty, notice: refusalNotice(state, state.code) };
  return { view: state, notice: undefined };
}
