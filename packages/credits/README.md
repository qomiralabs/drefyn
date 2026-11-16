# `@drefyn/credits`

The AI credit ledger. Generation, translation drafts, incident drafts, stale page drafts
and reader answers spend from one credit pool per organization, shared by all its
projects. Credits pay for AI work only;
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
  (`generation`, `translation_draft`, `incident_draft`, `stale_draft`, `reader_answer`)
  are frozen lists.
- `AiBudget`, `AI_OPERATIONS`, `unmeteredBudget()` and `createLedgerBudget()`: see below.
- `CreditError` is thrown for caller mistakes and business refusals. Its `code` is one of
  the codes below and its message is fixed per code, never echoing caller input.

## AI budget

`AiBudget` meters the AI work whose worth is known only after the run: stale page drafts
and reader answers (`AI_OPERATIONS`: `stale_draft`, `reader_answer`). It charges first and
refunds when the run produced nothing, so an unanswered question costs nothing and a burst
cannot spend credits the pool does not have.

- `charge(ref, { idempotencyKey, operation, floor? })` takes a `TenantRef` and returns one
  of:
  - `{ status: 'charged', entryId }`: a spend with `operation` as its reason was recorded.
    Repeating the same key returns the same entry and charges nothing more.
  - `{ status: 'refused' }`: the pool cannot cover it, or the charge would take the
    balance below `floor`. Nothing is recorded and the key stays free. Do not run the
    model.
  - `{ status: 'unmetered' }`: nothing is counted. Run the model.
- `floor` is a reserve the charge may not spend into, for example so a public assistant
  cannot empty the credits incident drafts need. It is checked by reading the balance
  before the spend, so parallel charges can pass it together and overshoot by at most
  their number times the cost; bound that with a concurrency limit. A retry of an applied
  charge may be refused once the pool has fallen below the floor, so crash recovery
  repeats the charge without a floor to find the entry it made.
- `refund(ref, { idempotencyKey, entryId })` reverses the whole charge, at most once.
  Repeating the same key changes nothing. A sweeper refunding a crashed turn must use the
  same refund key as the turn itself.

Amounts are whole credits. A fractional, negative, zero or unsafe cost or floor throws
`CREDIT_AMOUNT_INVALID`; an operation outside `AI_OPERATIONS` throws
`CREDIT_REASON_INVALID`. Checks run before any read or charge.

`createLedgerBudget({ ledger, creditsFor })` builds a metered budget over any
`CreditLedger`. `creditsFor(operation)` returns what one operation costs and is read on
every charge. This package holds no costs: they belong to whoever runs the pool.

`unmeteredBudget()` is what a self host wires: every charge returns `unmetered` and
refunds do nothing. Requests are still checked, so a caller bug fails the same way on
every install.

### Contract suite

`aiBudgetContract(make)` from `@drefyn/credits/testing` registers vitest suites that any
`AiBudget` over a ledger must pass: each result, the floor, refusals that record nothing,
and a fast-check property that under every interleaving of charge, refund and crash each
turn is charged at most once and refunded at most once. `make` returns
`{ budget, ledger, tenant, creditsFor }` with a pool that starts empty for `tenant`. The
entry needs `vitest` and `fast-check` in the consumer; production code never imports it.

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
run the same functions. `test/budget.test.ts` runs `aiBudgetContract` against
`createLedgerBudget` over the in memory ledger. The type tests in `test/types` use `@ts-expect-error`, so
`typecheck` is what proves them. Line coverage must stay at or above 95 percent.
