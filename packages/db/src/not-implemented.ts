// Placeholder thrown by every stub until #14 lands, so a test fails on its own assertion
// path rather than on a missing export. The inputs go into the message length only, so a
// stub never echoes a secret it was handed.
export function notImplemented(what: string, ...inputs: unknown[]): never {
  throw new Error(`${what} is not implemented yet (${String(inputs.length)} inputs)`);
}
