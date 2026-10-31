import type { TransportError } from './types.ts';

const OPEN_AFTER = 5;
const OPEN_FOR_MS = 30_000;

export type Gate = 'pass' | 'trial' | 'refuse';
export type Health = 'up' | 'down' | 'unknown';

// What a send says about the relay. A 5xx or a 4xx to a recipient means the relay
// answered, so it is up; a lost reply after the data says nothing either way.
export function healthOf(error: TransportError | null): Health {
  if (error === null) return 'up';
  if (error.phase === 'after_data' || error.code === 'email.unknown_outcome') return 'unknown';
  switch (error.code) {
    case 'email.connect_failed':
    case 'email.tls_failed':
    case 'email.auth_failed':
    case 'email.timeout':
      return 'down';
    // A 421 arrives with the greeting; a 4xx later is about one message.
    case 'email.deferred':
      return error.phase === 'connect' ? 'down' : 'up';
    case 'email.rejected':
      return 'up';
  }
}

// Stops a dead relay from collecting a backlog of sends that would each wait out the
// full deadline. After the pause one trial send decides whether it is back.
export class Breaker {
  #failures = 0;
  #openUntil: number | null = null;
  #trial = false;

  // Looks without taking the trial, for refusing early.
  check(now: number): Gate {
    if (this.#openUntil === null) return 'pass';
    if (now < this.#openUntil || this.#trial) return 'refuse';
    return 'trial';
  }

  acquire(now: number): Gate {
    const gate = this.check(now);
    if (gate === 'trial') this.#trial = true;
    return gate;
  }

  // Returns true when this result opened the breaker.
  record(health: Health, trial: boolean, now: number): boolean {
    if (trial) this.#trial = false;
    if (health === 'unknown' && !trial) return false;
    if (health === 'down') {
      this.#failures += 1;
      if (trial || (this.#openUntil === null && this.#failures >= OPEN_AFTER)) {
        this.#openUntil = now + OPEN_FOR_MS;
        return true;
      }
      return false;
    }
    this.#failures = 0;
    this.#openUntil = null;
    return false;
  }
}
