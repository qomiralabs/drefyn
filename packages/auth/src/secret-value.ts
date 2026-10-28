const HIDDEN = '[redacted]';

// Holds a secret that must be handed to a library as a string (OAuth client secrets).
// Every way a log line or a debugger turns it into text shows only the placeholder.
export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return HIDDEN;
  }

  toJSON(): string {
    return HIDDEN;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return HIDDEN;
  }
}
