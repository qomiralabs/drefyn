# `@drefyn/egress`

The one way out to a URL or host a customer chose. Spec fetch, feeds, imports, webhooks,
the try it proxy, monitors and model calls all go through it, and the
`drefyn/no-raw-egress` lint rule fails any network call made anywhere else.

Fetching a customer's URL is how a server gets tricked into reaching its own network:
cloud metadata, the database, a container next door. The guard closes that by checking
the address it is about to connect to, and then connecting to exactly that address.

## Public API

```ts
import { guardedFetch, policyFor } from '@drefyn/egress';

const result = await guardedFetch(
  specUrl,
  { headers: { accept: 'application/json' } },
  policyFor('spec_fetch'),
);
if (result.ok) {
  result.value.status; // number
  result.value.body; // Uint8Array, at most maxResponseBytes, as sent (never decompressed)
  result.value.url; // the URL that answered, after redirects
  result.value.address; // { address, family }, the checked address it was sent to
} else {
  result.error; // { code: 'egress.address_denied', hop: 0, addressClass: 'linkLocal' }
}
```

- `guardedFetch(url, init, policy)` makes one HTTP or HTTPS request. `init` takes
  `method`, `headers`, `body` (string or bytes) and `signal`.
- `guardedConnect(host, port, policy)` returns a connected TCP socket, for TCP checks.
- `guardedResolve(host, policy)` returns the checked addresses of a name, for DNS checks.
- `policyFor(purpose, options)` returns the default policy for a purpose. Spread it to
  tighten a field for one call site. `EGRESS_PURPOSES` lists the purposes.

A refusal, a DNS failure, a timeout or a network error comes back as a `Result`. Only a
programming error rejects: an invalid policy, a method that is not an HTTP token, or a
header with a bad name or a CR, LF or NUL in its value.

## What it checks

In order, for the first request and again for every redirect:

1. The URL parses with WHATWG URL, which folds `0x7f.1`, `2130706433`, `0177.0.0.1`,
   percent escapes and full width digits to one dotted address.
2. The scheme is one the policy allows. Userinfo (`http://good@169.254.169.254`) is
   refused, since its only use here is to make a URL read as another host.
3. The port is one the policy allows.
4. `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.home.arpa` and single label
   names are refused before any DNS query.
5. The name is resolved once. Every answer must be public unicast; one internal answer
   refuses the name. IPv4 mapped IPv6 (`::ffff:a.b.c.d`) is judged by the IPv4 address
   inside it. NAT64, 6to4, Teredo and IPv4 compatible addresses are refused whole, since
   each one routes to an IPv4 address of the attacker's choosing.
6. The guard opens the socket itself, to the checked address, and sends the name as Host
   and as TLS SNI. The certificate is checked against the name. Nothing resolves the name
   a second time, so a DNS answer that changes (rebinding) cannot move the connection.
7. Redirects are followed by hand, at most `maxRedirects`. Each one goes back to step 1.
   303, and a POST on 301 or 302, become a GET without a body. Authorization, Cookie and
   Proxy-Authorization are dropped when a redirect leaves the origin.
8. One clock covers DNS, connects, redirects and the body (`totalTimeoutMs`); each connect
   and TLS handshake also has `connectTimeoutMs`. A body over `maxResponseBytes` stops
   reading at once.

Every connection carries one request and is closed after it. A pooled connection could
carry a later request past a fresh check, so there is no pool.

The guard owns Host, Content-Length, Transfer-Encoding, Connection and the other framing
headers; a caller's values for them are dropped.

## Policies

| Purpose                                | Schemes     | Ports     | Redirects | Total timeout | Max bytes |
| -------------------------------------- | ----------- | --------- | --------- | ------------- | --------- |
| `monitor`                              | https, http | any       | 5         | 30 s          | 1 MiB     |
| `webhook`                              | https       | 443, 8443 | 0         | 10 s          | 64 KiB    |
| `feed`                                 | https       | 443       | 3         | 10 s          | 1 MiB     |
| `import`, `spec_fetch`, `media_import` | https       | 443       | 3         | 30 s          | 20 MiB    |
| `try_it`                               | https, http | any       | 0         | 15 s          | 5 MiB     |
| `model`                                | https       | 443       | 0         | 120 s         | 4 MiB     |

The connect timeout is 5 s for every purpose.

## Self hosting

Three options exist for installs on a private network. All are off unless the caller
passes them, and the hosted service passes none.

- `policyFor('webhook', { webhookAllowHttp: true })` lets webhooks go out over plain
  http. The app turns it on from `DREFYN_WEBHOOK_ALLOW_HTTP=true`.
- `policyFor('model', { modelLocal: true, allowPrivateCidrs: ['10.20.0.0/16'] })` lets a
  model server on the operator's network answer over plain http on any port. It needs a
  private range; without one the flag is ignored. `@drefyn/ai` turns it on only when
  `DREFYN_MODEL_ALLOW_PRIVATE_CIDRS` is set.
- `policyFor(purpose, { allowPrivateCidrs: ['10.20.0.0/16'] })` lets the listed ranges
  through, for example an internal API whose spec lives on the private network. With a
  list set, names such as `api.internal` are resolved instead of refused, and their
  answers must be public or inside the list. Keep the list narrow: everything in it is
  reachable by anyone who can enter a URL.

The guard is the only control inside the process. On a hosted install the network adds a
second one, so a guard bug still cannot reach the VPC or cloud metadata; on a self hosted
install that layer is the operator's firewall.

## Tests

- `test/corpus.test.ts`: the SSRF corpus. Each encoding, IPv6 form, refused name, DNS
  answer and scheme returns its `egress.*` code, and none reaches a dial.
- `test/rebinding.test.ts`: a real DNS server on loopback answers like a rebinding
  attacker (public, then private, TTL 0). No connection ever goes to a private address.
- `test/fetch.test.ts`: fixture servers for redirects at every hop, caps, timeouts, Host
  and SNI, certificate checks and credential handling on redirects.
- `fuzz/`: URL and address parsing against an independent numeric oracle. CI runs it for
  60 seconds per change in the `egress fuzz` job:
  `pnpm --filter @drefyn/egress test:fuzz [--seconds 60] [--seed n]`.
- The HTTPS tests need `openssl` on the path to make a throwaway certificate.
