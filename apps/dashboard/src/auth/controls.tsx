'use client';
import { Button } from '@drefyn/ui/react';
import { useRef, useState, useEffect, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { TextField } from '@drefyn/ui/react';

// Busy comes from the form itself, so no form can forget to show it.
export function Submit({
  label,
  busyLabel,
  stopped,
}: {
  label: string;
  busyLabel: string;
  // Why it cannot be pressed right now, read with the button.
  stopped?: string | undefined;
}): ReactNode {
  const { pending } = useFormStatus();
  if (stopped !== undefined) {
    return (
      <span className="grid">
        <Button variant="primary" size="lg" disabled aria-describedby="submit-stopped">
          {label}
        </Button>
        <span className="sr-only" id="submit-stopped">
          {stopped}
        </span>
      </span>
    );
  }
  return (
    <span className="grid">
      <Button type="submit" variant="primary" size="lg" busy={pending} busyLabel={busyLabel}>
        {label}
      </Button>
    </span>
  );
}

// The show button needs script, so with scripts off it is simply not there.
export function SecretField({
  id,
  label,
  name,
  autoComplete,
  error,
  description,
  optional = false,
}: {
  id: string;
  label: string;
  name: string;
  autoComplete: 'current-password' | 'new-password';
  error?: string | undefined;
  description?: string;
  optional?: boolean;
}): ReactNode {
  const [shown, setShown] = useState(false);
  return (
    <div className="auth-reveal">
      <TextField
        id={id}
        label={label}
        name={name}
        type={shown ? 'text' : 'password'}
        size="lg"
        autoComplete={autoComplete}
        required={!optional}
        {...(error === undefined ? {} : { error })}
        {...(description === undefined ? {} : { description })}
      />
      {error === undefined ? (
        <span className="auth-reveal-button auth-needs-script">
          <Button
            size="sm"
            variant="quiet"
            aria-pressed={shown}
            aria-label={`Show ${label.toLowerCase()}`}
            onClick={() => {
              setShown((value) => !value);
            }}
          >
            {shown ? 'Hide' : 'Show'}
          </Button>
        </span>
      ) : null}
    </div>
  );
}

export function CopyButton({
  text,
  describedBy,
}: {
  text: string;
  describedBy: string;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <span className="auth-needs-script">
      <Button
        size="sm"
        variant="quiet"
        aria-describedby={describedBy}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
          });
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </span>
  );
}

// Moves focus to the first notice a state brings, or the heading of a new step.
export function useFocusOnChange(state: unknown): (node: HTMLElement | null) => void {
  const root = useRef<HTMLElement | null>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const target = root.current?.querySelector<HTMLElement>('[data-notice], h1');
    target?.focus();
  }, [state]);
  return (node) => {
    root.current = node;
  };
}
