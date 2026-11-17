const REDACTED = '[redacted]';
const SHAPE = /^[\x21-\x7e]{8,512}$/;

// A provider key. Printing, logging, serialising or inspecting it shows only the
// placeholder; the adapters call reveal() for the one header that carries it.
export class ModelKey {
  readonly #value: string;

  constructor(value: string) {
    // The message never repeats the value: a key pasted with a stray space is still a key.
    if (!SHAPE.test(value)) {
      throw new TypeError('ai: a model key is 8 to 512 visible ASCII characters');
    }
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  /** The last four characters, the only part a person is ever shown again. */
  get hint(): string {
    return this.#value.slice(-4);
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }
}
