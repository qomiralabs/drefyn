import type { Socket } from 'node:net';
import { guardedConnectWith } from './connect.ts';
import { guardedFetchWith } from './fetch.ts';
import { guardedResolveWith } from './resolve.ts';
import { defaultRuntime } from './runtime.ts';
import type {
  CheckedAddress,
  EgressError,
  EgressPolicy,
  GuardedRequestInit,
  GuardedResponse,
  Result,
} from './types.ts';

export { EGRESS_PURPOSES, policyFor, type PolicyOptions } from './policy.ts';
export type {
  AddressClass,
  CheckedAddress,
  EgressError,
  EgressErrorCode,
  EgressPolicy,
  EgressPurpose,
  GuardedRequestInit,
  GuardedResponse,
  Result,
} from './types.ts';

/**
 * An HTTP request that can only reach public unicast addresses, or the ranges the policy
 * lists. A refusal or a network failure comes back as a Result; only a bad policy, method
 * or header, which are programming errors, rejects.
 */
export function guardedFetch(
  url: string,
  init: GuardedRequestInit,
  policy: EgressPolicy,
): Promise<Result<GuardedResponse, EgressError>> {
  return guardedFetchWith(defaultRuntime, url, init, policy);
}

/** A TCP connection under the same rules, for TCP checks and protocol clients. */
export function guardedConnect(
  host: string,
  port: number,
  policy: EgressPolicy,
): Promise<Result<Socket, EgressError>> {
  return guardedConnectWith(defaultRuntime, host, port, policy);
}

/** The checked addresses of a name, for DNS checks; never resolve a customer's name any other way. */
export function guardedResolve(
  host: string,
  policy: EgressPolicy,
): Promise<Result<readonly CheckedAddress[], EgressError>> {
  return guardedResolveWith(defaultRuntime, host, policy);
}
