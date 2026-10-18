# `@drefyn/tenancy`

Tenant IDs, tenant refs, cache keys and the public ID codec. Every store, cache and CDN purge
in Drefyn takes its tenant through these types, so the search proxy, probe ingest, credits and
the status notifier can use them without depending on the content engine or a database driver.
The only runtime import is `node:crypto`, for the key hash.

No other package defines these types or builds tenant IDs, cache keys or public IDs on its
own. Import them from `@drefyn/tenancy`.

## Public API

Everything other packages may use is exported from `src/index.ts`. Nothing else in `src/` is
public.

IDs:

- `OrganizationId`, `ProjectId`: branded UUID strings. A plain string does not typecheck as
  either, and one does not typecheck as the other.
- `organizationId(value)`, `projectId(value)`: the only way to brand a string. The input must
  be a canonical lowercase UUID (`8-4-4-4-12` hex, any 128 bit value); anything else throws
  `ID_MALFORMED`. Uppercase is rejected, not lowercased, so one tenant has one spelling.
- `IdKind`, `ID_KINDS`, `IdOf<K>`, `idOf(kind, value)`: the same for every kind. The kind is
  the public prefix: `org`, `prj`, `usr`, `mem`, `key`, `nod`, `ver`, `ast`, `cmp`, `inc`,
  `sub`, `whk`, `evt`, `crd`. `ID_KINDS` is frozen. Renaming a prefix breaks the public API.

Refs:

- `OrganizationRef`: `{ organizationId }`, for organization scoped stores such as members and
  the credit ledger.
- `TenantRef`: `{ organizationId, projectId }`, for project scoped stores. A `TenantRef` is an
  `OrganizationRef`; an `OrganizationRef` is not a `TenantRef`.

Cache keys:

- `CacheKey`: a branded string. `cacheKey` is the only way to build one.
- `CacheScope`: `page`, `nav`, `search`, `retrieval`, `render` or `asset`.
- `cacheKey(tenant, scope, ...parts)`: `v1:<orgId>:<projectId>:<scope>:<hash>`, where the hash
  is SHA-256 over the parts in base64url. Parts are length prefixed, so no two different lists
  of parts share a key, and they never appear in the key itself.
- `surrogateKey(tenant, scope, id?)`: a CDN surrogate key with the same tenant prefix, so a
  purge can never reach another tenant. The id is hashed, so the key is always visible ASCII
  with no spaces and safe in a `Surrogate-Key` header.

Public IDs:

- `toPublicId(kind, id)`: `<prefix>_<26 lowercase Crockford base32>` over the UUID's 128
  bits, for example `org_01arz3ndektsv4rrffq69g5fav`. Public IDs sort in the same order as
  their UUIDs.
- `parsePublicId(kind, value)`: the inverse, returning the branded ID. Each ID has exactly one
  public form; anything else is rejected.

Errors are thrown as `TenancyError` with a `code`. Messages never include the rejected input.

| Code                  | When                                                                 |
| --------------------- | -------------------------------------------------------------------- |
| `ID_MALFORMED`        | Not a canonical UUID, or not a well formed public ID of a known kind |
| `ID_WRONG_TYPE`       | A valid public ID of another kind                                    |
| `ID_KIND_UNKNOWN`     | A kind that is not in `ID_KINDS`                                     |
| `TENANT_REF_INVALID`  | The tenant passed to a key builder is not an object                  |
| `CACHE_SCOPE_UNKNOWN` | A scope that is not a `CacheScope`                                   |
| `CACHE_PART_INVALID`  | A cache key part or surrogate id that is not a string                |

UUIDv7 generation is not here; `newId` lives in `@drefyn/db`.

## Testing

```sh
pnpm --filter @drefyn/tenancy test
pnpm --filter @drefyn/tenancy typecheck
```

The type tests in `test/types` use `@ts-expect-error`, so `typecheck` is what proves them.
