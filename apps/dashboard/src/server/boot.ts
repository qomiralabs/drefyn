export interface StartCheck {
  readonly runtime: string | undefined;
  readonly production: boolean;
  readonly wrapperRunning: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly checkConfig: (env: Readonly<Record<string, string | undefined>>) => void;
  readonly exit: (code: number) => void;
  readonly log: (event: string, context: Record<string, string>) => void;
}

const fieldsOf = (error: unknown): Record<string, string> => {
  const { code, key, message } = (error ?? {}) as Record<string, unknown>;
  if (typeof code !== 'string') return { code: 'unknown' };
  // Database config errors name the key in fixed text and hold no value.
  const named = typeof message === 'string' ? /DREFYN_[A-Z_]+/.exec(message)?.[0] : undefined;
  const found = typeof key === 'string' ? key : named;
  return { code, ...(found === undefined ? {} : { key: found }) };
};

// A throwing register leaves Next up and answering 500, so a wrong start exits instead. The
// marker is the control; this makes a wrong deployment loud rather than a stream of 503s.
// A config error's message is left out, since a value can end up in one.
export function checkStart(check: StartCheck): void {
  if (check.runtime !== 'nodejs') return;
  if (check.production && !check.wrapperRunning) {
    check.log('dashboard.wrapper_missing', {});
    check.exit(1);
    return;
  }
  try {
    check.checkConfig(check.env);
  } catch (error) {
    check.log('dashboard.config_invalid', fieldsOf(error));
    check.exit(1);
  }
}
