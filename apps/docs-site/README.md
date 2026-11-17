# @drefyn/docs-site

The small server behind customer docs sites. Published pages are static files behind the CDN;
this app handles what cannot be static: deciding whose site a host is, and later previews,
private docs and form posts.

## Host resolution

Only the `Host` header is read. `X-Forwarded-Host`, `Forwarded` and the request URL are never
used, since any of them can be set by the caller.

| Host                                               | Answer                                               |
| -------------------------------------------------- | ---------------------------------------------------- |
| `<name>.<suffix>`, one label                       | The site holding that name, if any                   |
| `status`, `preview` or `www` under the suffix      | Unknown                                              |
| The suffix itself, or more than one label under it | Unknown                                              |
| The dashboard host or anything under it            | Unknown                                              |
| Anything else at or under the reserved domain      | Unknown                                              |
| Any other name                                     | A custom domain, only when verified and not detached |

Unknown is always a 404 with the same body as a missing page. There is no default site. A
directory that fails or takes over a second gives 503, and nothing is served.

Answers are cached by host for 30 seconds (5 seconds for unknown), at most 10,000 hosts,
least recently used first out. A detached domain keeps serving for up to 30 seconds.

The reserved domain is the suffix's parent when it has one (`docs.example.org` reserves
`example.org`), otherwise the suffix itself (`drefyn.app`).

## Config

| Key                       | Default                                                    | Meaning                                                  |
| ------------------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| `DREFYN_APP_ORIGIN`       | required                                                   | Dashboard origin; its host never serves customer content |
| `DREFYN_DOCS_HOST_SUFFIX` | `drefyn.app` when `DREFYN_HOSTED=true`, otherwise required | Default hosts are `<name>.<suffix>`                      |
| `DREFYN_DOCS_SITE_PORT`   | `3002`                                                     | Listening port                                           |

Startup fails when the suffix, or the domain it reserves, equals, contains or sits under the
dashboard host. The error names the key, never the value.

## Flag

`docs.site`, a release flag, off in production. Off for an organization means its hosts
answer 404 exactly as an unknown host does. Private sites answer 404 until the reader session
exists.

## Logs

One `site.request` line per request with the outcome, status, duration and, once a host
resolves, organization, project and site IDs. Never the host, path, query or headers. No
response sets a cookie.

## Public reads

Everything here is under `drefyn/published-reads-only`: content comes through the published
reader only.
