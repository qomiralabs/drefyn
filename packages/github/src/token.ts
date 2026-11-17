import type { TenantRef } from '@drefyn/tenancy';

export type TokenPermissions =
  | { readonly contents: 'read' }
  | { readonly contents: 'write' }
  | { readonly contents: 'write'; readonly pull_requests: 'write' };

const SHOWN = '[ShortLivedToken]';

// An installation token for one repository and one permission set, held for one job. The
// value lives in a private field, so JSON, String(), util.inspect and a spread all leave it
// out, and a logger handed the object cannot print it.
export class ShortLivedToken {
  readonly tenant: TenantRef;
  readonly installationId: number;
  readonly repositoryId: number;
  readonly permissions: TokenPermissions;
  readonly expiresAt: Date;
  #value: string | null;

  constructor(input: {
    tenant: TenantRef;
    installationId: number;
    repositoryId: number;
    permissions: TokenPermissions;
    expiresAt: Date;
    value: string;
  }) {
    this.tenant = input.tenant;
    this.installationId = input.installationId;
    this.repositoryId = input.repositoryId;
    this.permissions = input.permissions;
    this.expiresAt = input.expiresAt;
    this.#value = input.value;
  }

  get disposed(): boolean {
    return this.#value === null;
  }

  // The Authorization header value. Using a token after its job or its hour is a bug in the
  // caller, so it throws rather than letting GitHub answer 401 later.
  authorization(now: number = Date.now()): string {
    if (this.#value === null) throw new Error('github: token disposed');
    if (now >= this.expiresAt.getTime()) throw new Error('github: token expired');
    return `token ${this.#value}`;
  }

  dispose(): void {
    this.#value = null;
  }

  toJSON(): Record<string, unknown> {
    return {
      installationId: this.installationId,
      repositoryId: this.repositoryId,
      permissions: this.permissions,
      expiresAt: this.expiresAt.toISOString(),
    };
  }

  toString(): string {
    return SHOWN;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return SHOWN;
  }
}
