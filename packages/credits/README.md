# `@drefyn/credits`

The AI credit ledger. Generation, translation drafts and incident drafts spend from one
credit pool per organization, shared by all its projects. Credits pay for AI work only;
sends are never credits. The ledger never goes below zero and never charges twice for a
retried request. This package holds the ledger rules and an in memory store; a Postgres
store with the same contract follows.

Self hosting: the ledger is open core with no hosted dependency. How many credits an
operation costs and how many an organization gets each period are set by whoever runs it,
not by this package. A self hosted install that wants no cap simply grants enough credits.

## Public API

Everything other packages may use is exported from `src/index.ts`. Nothing else in `src/`
is public.

- `credits(value)` builds `Credits`, a branded integer: a non negative safe integer number
  primitive. Fractions, NaN, infinities, negatives, unsafe integers, bigints, strings and
  boxed numbers throw `CREDIT_AMOUNT_INVALID`. `-0` becomes `0`. Never use floats for
  credits; arithmetic on `Credits` gives a plain `number` that must go back through
  `credits()`.
- `createMemoryLedger()` returns a `CreditLedger` held in process memory, for tests and
  local tools. State is lost on restart.
- `CreditLedger` is the store contract. Every method is async and atomic per organization,
  and takes an `OrganizationRef` (a `TenantRef` works too; only `organizationId` is read).
  - `balance(ref)` and `entries(ref)`: the current balance, and a frozen list of entries in
    the order they were applied. The balance always equals the signed sum of the entries.
  - `grant(ref, { idempotencyKey, amount })` adds credits.
  - `spend(ref, { idempotencyKey, amount, reason })` takes credits for one of
    `SPEND_REASONS`. All or nothing: if the balance cannot cover it, it returns
    `{ status: 'insufficient', requested, available }` and records nothing. The caller
    must not run the model in that case.
  - `expire(ref, { idempotencyKey, amount })` removes credits, all or nothing like a spend.
    The caller computes how much is left to expire; the ledger keeps no dates or lots.
  - `reverse(ref, { idempotencyKey, entryId })` returns a whole spend, once. Use it when a
    model call fails before producing output.
- `CreditEntry` is one frozen ledger row: `id`, `organizationId`, `kind`, `amount`,
  `idempotencyKey`, plus `reason` on a spend and `reverses` on a reversal. Entries never
  carry a project id because the pool belongs to the organization.
- `CreditOutcome` is `applied` with the entry, or `insufficient`.
- `ENTRY_KINDS` (`grant`, `spend`, `reversal`, `expiry`) and `SPEND_REASONS`
  (`generation`, `translation_draft`, `incident_draft`) are frozen lists.
- `CreditError` is thrown for caller mistakes and business refusals. Its `code` is one of
  the codes below and its message is fixed per code, never echoing caller input.

## Idempotency

Every write carries an `idempotencyKey` of 1 to 200 Unicode code points, well formed and
without NUL, compared exactly and scoped per organization.

- A key admits at most one applied entry per organization.
- Repeating an applied request with the same key returns the original outcome and changes
  nothing, even if the balance could no longer cover it.
- Reusing a key with a different request (another kind, amount, reason or reversal target)
  throws `CREDIT_IDEMPOTENCY_CONFLICT` and changes nothing. The conflict check runs before
  the balance and overflow checks.
- A refused or invalid request records nothing, so the same key may be retried, for
  example after a top up.

## Error codes

| Code                          | Meaning                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `CREDIT_AMOUNT_INVALID`       | Not a non negative safe integer, or zero on an entry.                                      |
| `CREDIT_KEY_INVALID`          | Key missing, not an own string, empty, over 200 code points, ill formed or containing NUL. |
| `CREDIT_REASON_INVALID`       | Spend reason is not one of `SPEND_REASONS`.                                                |
| `CREDIT_ORGANIZATION_INVALID` | Ref is not an object with an own canonical organization id.                                |
| `CREDIT_IDEMPOTENCY_CONFLICT` | Key already used in this organization with a different request.                            |
| `CREDIT_ENTRY_NOT_FOUND`      | Reversal target is unknown, malformed or another organization's.                           |
| `CREDIT_NOT_REVERSIBLE`       | Reversal target is not a spend, or was already reversed.                                   |
| `CREDIT_BALANCE_OVERFLOW`     | A grant or reversal would push the balance past `2^53 - 1`.                                |

Checks run in this order: organization ref, key, then the body (amount or entry id, then
reason). Only own properties are read, each once.

## Testing

```sh
pnpm --filter @drefyn/credits test
pnpm --filter @drefyn/credits typecheck
```

The behavior suites live in `test/contract` as functions that take a ledger factory;
`test/memory.test.ts` runs them against `createMemoryLedger`, and the Postgres store will
run the same functions. The type tests in `test/types` use `@ts-expect-error`, so
`typecheck` is what proves them. Line coverage must stay at or above 95 percent.
