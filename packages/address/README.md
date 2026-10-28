# `@drefyn/address`

The one email address rule. Auth normalises every address it reads with it, and email
checks every recipient, sender and reply to address with it before anything reaches a
header, so the two packages agree without depending on each other.

The package has no dependencies and imports nothing, not even a Node built in, so it is
listed in `drefyn.pureEntries` and can load in client components as well as on the server.
In a browser the IDNA step is the engine's own. Chromium, Firefox and WebKit are proved to
give Node's answer on the bypass corpus and a set of real addresses (see Tests), but their
IDNA tables can still differ from Node's on other input. The server's answer is the one
that gets stored; a client result is only a hint for a form.

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
8. The domain may not hold a default ignorable code point (soft hyphen, zero width space,
   word joiner, variation selectors and the like), since IDNA would drop it silently. ZWNJ
   (U+200C) and ZWJ (U+200D) are the exception: IDNA refuses them unless the script needs
   them, as in Persian and after an Indic virama, and then keeps them in the punycode, so
   the spelling with a joiner is a different domain. In ASCII the domain may hold only
   letters, digits, dots and hyphens, checked both as typed and in its NFKC form; other non
   ASCII is left to IDNA. It is lower cased and converted to ASCII with the WHATWG URL host
   rules (the same conversion as `node:url` `domainToASCII`). The result needs two or more
   labels, each 1 to 63 letters, digits or inner hyphens, at most 253 characters in all, and
   a top label that is not all digits, which rules out IP addresses: `domain`.
9. The local part is lower cased. If the joined address is now over 254 characters,
   because IDNA made the domain longer: `length`.

Dots and plus tags are kept: `a.b+c@example.com` and `ab@example.com` are different
addresses. Folding them is the mailbox provider's business.

This is stricter than RFC 5322 on purpose. Address parser advisories in mail libraries
sit in quoted local parts, comments and groups, all of which are refused here. Step 8's
ASCII check matters because the URL host parser stops at `/ ? # \`, decodes `%` escapes
and drops tabs, and would otherwise turn `jane@example.com/evil` into `jane@example.com`.
The NFKC check matters because some browsers fold full width and small forms of those
characters (U+FF0F, U+FE6B, U+FF05 and others) into ASCII before splitting the host, so
WebKit would turn `jane@example.com` followed by U+FE6B and `evil.com` into
`jane@evil.com`.

Compatibility forms that are the same DNS name under UTS 46 are accepted on purpose: full
width letters and digits, the ideographic full stop and similar map to the plain ASCII
domain, which is the address the mail goes to.

## Tests

`pnpm --filter @drefyn/address test` runs table tests for every refusal reason, property
tests for idempotence, the guard and agreement with `node:url` `domainToASCII`, and type
tests for the brand. Coverage must stay at 95 percent or more for lines and branches.
`FC_SEED` replays the properties under another seed.

`packages/ui/e2e/address.spec.ts` serves this package's source, types removed, to
Chromium, Firefox and WebKit in the pinned Playwright image, and checks that every engine
refuses the delimiter, compatibility form and ignorable bypasses and gives Node's answer on
real addresses. It runs in the `keyboard-chromium`, `keyboard-firefox` and
`keyboard-webkit` jobs. Locally:
`node scripts/in-container.ts playwright test --project=keyboard-chromium --project=keyboard-firefox --project=keyboard-webkit e2e/address.spec.ts`
from `packages/ui`.
