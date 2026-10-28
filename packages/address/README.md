# `@drefyn/address`

The one email address rule. Auth normalises every address it reads with it, and email
checks every recipient, sender and reply to address with it before anything reaches a
header, so the two packages agree without depending on each other.

The package has no dependencies and imports nothing, not even a Node built in, so it is
listed in `drefyn.pureEntries` and loads in client components as well as on the server.

## Public API

```ts
const result = normalizeEmailAddress(input);
if (result.ok) {
  lookUp(result.value); // NormalizedEmailAddress
} else {
  result.error; // { code: 'address.invalid', reason }
}

if (isNormalizedEmailAddress(stored)) send(stored);
```

- `normalizeEmailAddress(input)` returns `{ ok: true, value }` or
  `{ ok: false, error: { code: 'address.invalid', reason } }`. It never throws. The error
  never contains the input.
- `isNormalizedEmailAddress(value)` is true only when `normalizeEmailAddress(value)` would
  accept the value and return it unchanged. Use it where a value should already be
  normalised, such as an address read back from the database or passed to a mailer.
- `NormalizedEmailAddress` is a branded string. A plain string does not typecheck as one;
  only the two functions above produce it.
- `AddressError` and `Result<T, E>` are the shapes above.

## The rule

In order, with the refusal reason for each step:

1. Over 1,016 characters before trimming: `length`. This only bounds the work.
2. A CR or LF anywhere, before trimming, so a trailing newline is refused rather than
   trimmed away: `control`.
3. Trim with `String.prototype.trim`.
4. Any C0 or C1 control character, DEL, U+2028 or U+2029 left after trimming: `control`.
5. Over 254 characters: `length`.
6. Not exactly one `@`: `shape`.
7. The local part must be a dot atom of at most 64 characters: printable ASCII from
   ``A-Z a-z 0-9 ! # $ % & ' * + - / = ? ^ _ ` { | } ~``, dots only between atoms. Quoted
   strings, comments, spaces, escapes and non ASCII are refused: `local_part`.
8. The domain may hold only letters, digits, dots and hyphens in ASCII; non ASCII is left
   to IDNA. It is lower cased and converted to ASCII with the WHATWG URL host rules (the
   same conversion as `node:url` `domainToASCII`). The result needs two or more labels,
   each 1 to 63 letters, digits or inner hyphens, at most 253 characters in all, and a top
   label that is not all digits, which rules out IP addresses: `domain`.
9. The local part is lower cased. If the joined address is now over 254 characters,
   because IDNA made the domain longer: `length`.

Dots and plus tags are kept: `a.b+c@example.com` and `ab@example.com` are different
addresses. Folding them is the mailbox provider's business.

This is stricter than RFC 5322 on purpose. Address parser advisories in mail libraries
sit in quoted local parts, comments and groups, all of which are refused here. Step 8's
ASCII check matters because the URL host parser stops at `/ ? # \`, decodes `%` escapes
and drops tabs, and would otherwise turn `jane@example.com/evil` into `jane@example.com`.

## Tests

`pnpm --filter @drefyn/address test` runs table tests for every refusal reason, property
tests for idempotence, the guard and agreement with `node:url` `domainToASCII`, and type
tests for the brand. Coverage must stay at 95 percent or more for lines and branches.
`FC_SEED` replays the properties under another seed.
