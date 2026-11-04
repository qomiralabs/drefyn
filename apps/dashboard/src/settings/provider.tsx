'use client';
import { toast } from '@drefyn/ui/react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { problemWords, settle, type Outcome, type Problem } from './results.ts';

type Answer<T> = Parameters<typeof settle<T>>[0];

interface Settings {
  // Runs an action. When it needs a fresh sign in the prompt comes first and the same call
  // runs once more. `what` finishes the prompt's sentence: "Creating an API key needs...".
  readonly act: <T>(what: string, call: () => Promise<Answer<T>>) => Promise<Outcome<T>>;
  // The failure as a toast, for a row that has no form to show it in.
  readonly complain: (title: string, problem: Problem) => void;
  readonly refresh: () => void;
}

const Context = createContext<Settings | null>(null);

export function useSettings(): Settings {
  const value = useContext(Context);
  if (value === null) throw new Error('useSettings needs the settings provider.');
  return value;
}

const StepUp = dynamic(() => import('./step-up.tsx').then((mod) => mod.StepUpDialog), {
  ssr: false,
});

const CANCELLED: Outcome<never> = { ok: false, problem: { kind: 'refused', code: 'CANCELLED' } };
const OFFLINE: Outcome<never> = { ok: false, problem: { kind: 'failed', reference: 'network' } };

export const wasCancelled = (outcome: Outcome<unknown>): boolean =>
  !outcome.ok && outcome.problem.kind === 'refused' && outcome.problem.code === 'CANCELLED';

export function SettingsProvider({ children }: { children: ReactNode }): ReactNode {
  const router = useRouter();
  const [prompt, setPrompt] = useState<string | null>(null);
  const answer = useRef<((confirmed: boolean) => void) | null>(null);

  const ask = useCallback(
    (what: string) =>
      new Promise<boolean>((resolve) => {
        answer.current = resolve;
        setPrompt(what);
      }),
    [],
  );

  const act = useCallback(
    async <T,>(what: string, call: () => Promise<Answer<T>>): Promise<Outcome<T>> => {
      const attempt = async (): Promise<Outcome<T>> => {
        try {
          return settle(await call());
        } catch {
          return OFFLINE;
        }
      };
      const first = await attempt();
      if (first.ok || first.problem.kind !== 'step_up') return first;
      return (await ask(what)) ? attempt() : CANCELLED;
    },
    [ask],
  );

  const value = useMemo<Settings>(
    () => ({
      act,
      complain: (title, problem) => {
        toast({ title, description: problemWords(problem), tone: 'error' });
      },
      refresh: () => {
        router.refresh();
      },
    }),
    [act, router],
  );

  return (
    <Context.Provider value={value}>
      {children}
      {prompt === null ? null : (
        <StepUp
          what={prompt}
          onClose={(confirmed) => {
            setPrompt(null);
            answer.current?.(confirmed);
            answer.current = null;
          }}
        />
      )}
    </Context.Provider>
  );
}
