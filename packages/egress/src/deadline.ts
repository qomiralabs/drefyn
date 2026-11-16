// One clock for a whole exchange: DNS, every connect, every redirect and the body. The
// caller's signal ends it too, and the code says which of the two fired.

export type StopCode = 'egress.timeout' | 'egress.aborted';

export class Deadline {
  readonly signal: AbortSignal;
  readonly #controller = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #caller: AbortSignal | undefined;
  #code: StopCode = 'egress.timeout';

  constructor(totalMs: number, caller?: AbortSignal) {
    this.signal = this.#controller.signal;
    this.#caller = caller;
    this.#timer = setTimeout(() => {
      this.#stop('egress.timeout');
    }, totalMs);
    if (caller?.aborted === true) this.#stop('egress.aborted');
    caller?.addEventListener('abort', this.#onCallerAbort, { once: true });
  }

  get code(): StopCode {
    return this.#code;
  }

  readonly #onCallerAbort = () => {
    this.#stop('egress.aborted');
  };

  #stop(code: StopCode): void {
    if (this.signal.aborted) return;
    this.#code = code;
    this.#controller.abort();
  }

  /** Calls stop once if the deadline passes; returns a function that cancels the watch. */
  watch(stop: () => void): () => void {
    if (this.signal.aborted) {
      stop();
      return () => undefined;
    }
    this.signal.addEventListener('abort', stop, { once: true });
    return () => {
      this.signal.removeEventListener('abort', stop);
    };
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#caller?.removeEventListener('abort', this.#onCallerAbort);
  }
}

/** Settles with the promise, or with undefined once the deadline passes. */
export function beforeDeadline<T>(
  deadline: Deadline,
  promise: Promise<T>,
): Promise<{ readonly value: T } | undefined> {
  return new Promise((resolve, reject) => {
    const unwatch = deadline.watch(() => {
      resolve(undefined);
    });
    promise.then(
      (value) => {
        unwatch();
        resolve({ value });
      },
      (error: unknown) => {
        unwatch();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
