# `@drefyn/site`

Turns one docs or status page into static HTML with our own React server render. No client
React, no hydration and no site build: a state change or a page edit renders that one page,
in under a millisecond.

The package is pure Apache 2.0 open core. It needs React, zod and two workspace packages, and
no hosted service. Next stays in the dashboard.

## Public API

```ts
const config = loadSiteConfig(process.env);
if (!config.ok) throw new Error(config.error.key);

const result = renderStatusPage(
  {
    tenant,
    route: '/',
    locale: 'en',
    theme: {},
    policy: { version: 1, maxFirstResponseBytes: config.value.maxFirstResponseBytes },
    data: { version, builtAt, css, scripts, pages },
  },
  { log },
);
if (result.ok) upload(renderKey('status', input), result.value.html);
```

- `renderDocsPage(input, deps?)` and `renderStatusPage(input, deps?)` return
  `{ ok: true, value: { html, csp, assets, report } }` or `{ ok: false, error }`. They never throw.
  The same input gives the same bytes. They read no clock, no random source and no environment,
  so the build time arrives in `data.builtAt`.
- `pruneCss(html, css)` returns the CSS one page needs: rules whose classes appear in the page
  and custom properties something reads. It never throws. A class that only a plain script adds
  must also appear in the rendered HTML, or its rule is dropped.
- `renderKey(surface, input)` is the `CacheKey` for a page, with both tenant ids.
- `loadSiteConfig(env)` reads the one setting below.
- `data.pages` maps each route to `{ title, description, body }`. `body` is a React element, and
  for customer content it is the element `renderSafe` returned. Page templates live with each
  surface, not here.
- `theme` is `{ light, dark }` and takes only the tokens a customer may set. State colours are
  not among them.

Interactive React components stay out of public pages. A component that suspends fails the page.

## Content Security Policy

Every page carries its own policy, and `csp` is the `Content-Security-Policy` header to serve
with it. Static files cannot carry a fresh nonce per response, so the policy allows the one
inline theme line and the page's inline stylesheet by SHA-256 hash, and plain scripts from the
page's own origin. Nothing else runs or styles the page: no `unsafe-inline`, no `unsafe-eval`,
no style attributes, no other host.

```text
default-src 'none';script-src 'self' 'sha256-<theme line>';style-src 'sha256-<this page's CSS>';
img-src 'self' data:;font-src 'self';connect-src 'self';form-action 'self';base-uri 'none';
object-src 'none';frame-ancestors 'none'
```

The page repeats the policy in a `<meta>` tag ahead of everything it guards, so a plain static
host that sets no headers is still covered. Browsers ignore `frame-ancestors` there, so only the
header stops framing. Serve the header wherever the host allows it.

The inline CSS is written out with line endings and NUL characters already as the HTML parser
leaves them, so the hash the browser computes matches ours. The same input gives the same hashes.

`pnpm --filter @drefyn/site test:e2e` renders one page of each type and loads it in Chromium,
Firefox and WebKit: the clean page must report no violation, a page with one byte changed in
its theme line or stylesheet must report, and a page with injected scripts, handlers and styles
must run none of them, by header, by meta tag and by both.

## Errors

| Code                   | When                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `site.unknown_route`   | `data.pages` has no such route                                                       |
| `site.budget_exceeded` | Over the JS, font or first response budget; `budget`, `limit` and `actual` say which |
| `site.render_failed`   | `reason` is `invalid_input`, `component_threw`, `client_boundary` or `unsafe_css`    |

Unsafe CSS means a closing style tag, an `@import` or a `url()` to another host.

## Budgets

| Surface | JS gzipped   | Font files | First response gzipped               |
| ------- | ------------ | ---------- | ------------------------------------ |
| Docs    | under 90,000 | 3          | no limit                             |
| Status  | under 50,000 | 0          | warns at the target, fails at 16,000 |

The inline theme line counts as JS. `report` holds `htmlGzipBytes`, `jsGzipBytes` and
`overFirstResponseTarget` for each page.

## Configuration

| Variable                               | Default | Meaning                                                          |
| -------------------------------------- | ------- | ---------------------------------------------------------------- |
| `DREFYN_SITE_MAX_FIRST_RESPONSE_BYTES` | 14000   | Status first response warning target, a whole number up to 16000 |

## Logs

The logger in `deps` hears `site.unknown_route`, `site.render_failed`, `site.budget_exceeded` and
`site.first_response_over_target`. Lines carry the organization ID, project ID, surface, render
key and sizes. Routes, titles and page content never reach a log; the key holds a hash of the
route.

## Public page gates

`gates/` holds the CI gates for built public pages. `gates/server.ts` renders a docs page, a
status home page and the largest incident fixture with this package and serves them from
loopback the way a static host would: the policy header, gzip and the docs fonts.

| Gate           | Measure                                                     | Fails when                                     |
| -------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| Lighthouse     | Mobile defaults, simulated slow 4G and CPU                  | Any category under 95 (docs) or 98 (status)    |
| Status LCP     | The same Lighthouse run                                     | Over 1,000 ms                                  |
| JS             | Every script the browser received plus inline ones, gzipped | 90,000 bytes or more (docs), 50,000 (status)   |
| First response | The status page as served, gzipped                          | Warns at 14,000 bytes, fails at 16,000         |
| Scripts off    | Each page with JavaScript disabled, desktop and mobile      | Required text hidden, or a link with no target |
| axe            | WCAG 2.2 AA tags, light and dark, desktop and mobile        | Any violation                                  |
| Keyboard       | Tab through the page                                        | Order differs from the DOM, or no visible ring |
| Reduced motion | Every transition under `prefers-reduced-motion: reduce`     | Anything moves, or a fade passes 120 ms        |
| Visual         | Full page screenshots, zero tolerance                       | Any pixel changes                              |

Scripts off, axe, keyboard, reduced motion and visual run on Chromium, Firefox and WebKit.

```sh
pnpm --filter @drefyn/site test:gates --project=budgets   # Lighthouse, JS, first response
pnpm --filter @drefyn/site test:gates --project=chromium  # also firefox, webkit
pnpm --filter @drefyn/site test:gates:update              # visual baselines, in the pinned image
pnpm --filter @drefyn/site test:gates:controls            # every gate against a broken page
```

Visual baselines are made and compared only inside the pinned Playwright image, so
`test:gates:update` starts it through Docker. `DREFYN_SITE_GATE_BREACH=<name>` swaps one page
for a broken twin with the same path; `gates/controls.ts` runs each one and expects exactly the
matching gate to fail, for the right reason. The status first response warning shows as a
workflow annotation and does not fail the job.

## Tests

`pnpm --filter @drefyn/site test` runs the suite. `pnpm --filter @drefyn/site bench` renders a
page of twenty components thousands of times under the production build of React and fails if
p99 reaches 5 ms.
