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
  - `settle(ref, { idempotencyKey, entryId, amount })` returns part of a spend, once, after
    the real cost is known: the spend was the hold and the settlement gives back the unused
    part. `amount` must be at least 1 and less than the spend (returning all of it is a
    reversal), otherwise `CREDIT_AMOUNT_INVALID` and nothing is written. A spend closes
    once: a second settlement, a settlement after a reversal and a reversal after a
    settlement each throw `CREDIT_NOT_REVERSIBLE`. It never needs balance, so it is never
    refused for one. If the real cost is the whole hold or more, write nothing.
- `CreditEntry` is one frozen ledger row: `id`, `organizationId`, `kind`, `amount`,
  `idempotencyKey`, plus `reason` on a spend, `reverses` on a reversal and `settles` on a
  settlement. Entries never carry a project id because the pool belongs to the organization.
- `CreditOutcome` is `applied` with the entry, or `insufficient`.
- `ENTRY_KINDS` (`grant`, `spend`, `reversal`, `expiry`, `settlement`) and `SPEND_REASONS`
  (`generation`, `translation_draft`, `incident_draft`, `stale_draft`, `reader_answer`)
  are frozen lists.
- `AiBudget`, `AI_OPERATIONS`, `unmeteredBudget()` and `createLedgerBudget()`: see below.
- `CreditError` is thrown for caller mistakes and business refusals. Its `code` is one of
  the codes below and its message is fixed per code, never echoing caller input.

## AI budget

`AiBudget` meters the AI work whose worth is known only after the run (`AI_OPERATIONS`:
`stale_draft`, `reader_answer`, `translation_draft`, `incident_draft`, `generation`). It charges first and
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

## Rates

Each model burns credits at its own per token rate, read from one rate table that whoever
runs the pool supplies. This
package holds the table type, a strict parser and the integer math; it holds no rates, no
model names and no figures.

- `parseRateTable(value)` checks a table (usually parsed JSON) and returns a frozen
  `RateTable` holding only the known fields, so it serializes back to an equal table. A
  table has a `version`, `models`, `defaults` (one model per AI operation), a
  `checkModel` and `reference` usage profiles. Each `ModelRate` has a `modelId`, a
  `premium` flag and one or more `RateBand`s. A band has `upToPromptTokens` and a rate for
  each token class (`input`, `cacheWrite5m`, `cacheWrite1h`, `cacheRead`, `output`) as
  `Millicredits` per million tokens: a millicredit is a thousandth of a credit.
- Rules: model ids are unique and match `^[a-z0-9][a-z0-9.-]{0,62}$`; band bounds are
  strictly ascending and only the last band, which must be there, has a null bound;
  defaults name non premium models in the table; the check model is in the table; at most
  one reference profile per operation, each with at least one call; every number is a
  non negative safe integer; unknown fields are refused. At most 256 models, 16 bands per
  model and 64 calls per profile or operation.
- `estimateCredits(table, plannedCalls)` is the hold for one operation, an upper bound:
  each prompt token at the dearest prompt rate of every band up to the one the largest
  prompt lands in, each output token at the dearest output rate there, summed over the
  calls (the check included) and rounded up. At least 1.
- `creditsForUsage(table, calls)` is the charge once usage is known: every call of the
  operation summed in millicredits and rounded once, half up. At least 1. The band is
  picked per call from its whole prompt, cache tokens included, so 100,000 tokens stay
  in a band that ends at 100,000 and 100,001 move to the next. Within the plan it never
  exceeds the estimate.
- `estimateMonthlyRuns(table, monthly, operation, modelId)` is "about N runs a month":
  `monthly` over the charge of the operation's reference profile (main calls on
  `modelId`, check calls on the check model), rounded down. `undefined` when the table
  has no profile for the operation.
- `RateTableError` has a `code`, a `path` such as `models[2].bands[0].output` or
  `calls[1].modelId`, and a fixed message per code ending in that path. It never
  carries a value from the table or the usage.

| Code                 | Meaning                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `RATE_TABLE_INVALID` | The table breaks a rule above.                                          |
| `RATE_MODEL_UNKNOWN` | A call names a model that is not in the table.                          |
| `RATE_USAGE_INVALID` | A call, token count or operation is malformed, or the result is unsafe. |

All arithmetic is in `BigInt`; no floating point touches a rate or a charge.

## Idempotency

Every write carries an `idempotencyKey` of 1 to 200 Unicode code points, well formed and
without NUL, compared exactly and scoped per organization.

- A key admits at most one applied entry per organization.
- Repeating an applied request with the same key returns the original outcome and changes
  nothing, even if the balance could no longer cover it.
- Reusing a key with a different request (another kind, amount, reason or target entry)
  throws `CREDIT_IDEMPOTENCY_CONFLICT` and changes nothing. The conflict check runs before
  the balance and overflow checks.
- A refused or invalid request records nothing, so the same key may be retried, for
  example after a top up.

## Error codes

| Code                          | Meaning                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `CREDIT_AMOUNT_INVALID`       | Not a non negative safe integer, zero on an entry, or a settlement not below its spend.    |
| `CREDIT_KEY_INVALID`          | Key missing, not an own string, empty, over 200 code points, ill formed or containing NUL. |
| `CREDIT_REASON_INVALID`       | Spend reason is not one of `SPEND_REASONS`.                                                |
| `CREDIT_ORGANIZATION_INVALID` | Ref is not an object with an own canonical organization id.                                |
| `CREDIT_IDEMPOTENCY_CONFLICT` | Key already used in this organization with a different request.                            |
| `CREDIT_ENTRY_NOT_FOUND`      | Reversal or settlement target is unknown, malformed or another organization's.             |
| `CREDIT_NOT_REVERSIBLE`       | Reversal or settlement target is not a spend, or was already reversed or settled.          |
| `CREDIT_BALANCE_OVERFLOW`     | A grant, reversal or settlement would push the balance past `2^53 - 1`.                    |

Checks run in this order: organization ref, key, then the body (amount or entry id, then
reason). A settlement checks its amount, then its target, then whether the target is still
open, then the amount against the spend. Only own properties are read, each once.

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
