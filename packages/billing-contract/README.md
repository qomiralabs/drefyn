# `@drefyn/billing-contract`

The versioned contract between the dashboard and a billing provider. It holds types, zod
schemas for every request and answer under `/billing/v1`, a client, a fake provider and a
contract suite. It names no provider and holds no prices: amounts always come from the
provider, in integer cents, currency `usd`.

Self hosted installs never use it. The dashboard shows billing pages only when a provider
URL is configured.

## Client

```ts
import { createBillingClient, isBillingError } from '@drefyn/billing-contract';

const billing = createBillingClient({ baseUrl, token, timeoutMs: 2000, actor: { userId } });
const summary = await billing.summary(organizationId);
```

- Every call sends `Authorization: Bearer <token>` and `Drefyn-Actor: <user id>`.
- Every call that is not a GET sends `Idempotency-Key`. Plan changes, cancelling a pending
  change and the keep editable list take the key from the caller, so a double click is one
  change; the other writes get a fresh key per call.
- Inputs are checked before anything is sent and refused as `billing.invalid_input`.
- Answers are checked against the schemas. A timeout, a refused connection, an answer over
  64 KB, or an answer that fails its schema is `billing.unavailable`, never a crash.
- The client does not retry. A page that cannot load billing shows the plan as unchanged.

Errors are `BillingError` with a `code` from `BILLING_ERROR_CODES`. Pages branch on the code;
the message is for a person to read.

## Fake provider

`@drefyn/billing-contract/fake` starts an in memory provider on `127.0.0.1` for tests and
e2e runs. The caller passes the plans, so the fake holds no amounts of its own.

```ts
const fake = await startFakeBillingProvider({ token, plans, owners: [ownerId] });
fake.setScenario('past_due');
await fake.close();
```

Scenarios: `active`, `no_card`, `card_expiring`, `past_due`, `scheduled_downgrade`,
`declined_upgrade`, `contract`, `unavailable`, `slow`, `malformed` and `oversized`.

## Contract suite

`@drefyn/billing-contract/contract-suite` exports `CONTRACT_CHECKS` and
`runContractSuite(target)`. Any provider must pass every check against a test organization.
The checks write billing details on that organization and change nothing else.

## Changing the contract

New fields are optional and new endpoints are new paths. A breaking change is `/billing/v2`,
served alongside v1. Add every new route to `BILLING_ROUTES`; the schema tests fail until it
has a sample.

## Testing

```sh
pnpm --filter @drefyn/billing-contract test
```
